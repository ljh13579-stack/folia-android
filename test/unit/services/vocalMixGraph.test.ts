import { describe, expect, it, vi } from 'vitest';
import {
    applyVocalMixPosition,
    createVocalMixGraph,
    INSTRUMENTS_END_LIFT,
    MID_PULL_AT_VOCALS,
    mixToGains,
    registerVocalMixGraph,
    SIDE_CUT_AT_VOCALS,
    VOCAL_BAND_BOOST,
    VOCALS_END_TRIM,
} from '@/services/vocalMixGraph';

// test/unit/services/vocalMixGraph.test.ts
// 人声/伴奏：滑块位置到四个增益分量的映射，以及图结构与注册表。
// 透明性靠「Mid 增益 1 + Side 增益 1 恒等还原 L/R」保证，p = 0.5 必须是原声。

type ConnectCall = { target: FakeNode; output?: number; input?: number };
type FakeNode = {
    kind: string;
    connect: (target: FakeNode, output?: number, input?: number) => void;
    calls: ConnectCall[];
};
type GainLike = FakeNode & {
    gain: { value: number; setTargetAtTime: ReturnType<typeof vi.fn> };
};
type FilterLike = FakeNode & {
    type: string;
    frequency: { value: number };
};

const asGain = (node: FakeNode): GainLike => node as unknown as GainLike;
const asFilter = (node: FakeNode): FilterLike => node as unknown as FilterLike;

const createFakeContext = () => {
    const node = <T extends object>(kind: string, extra = {} as T) => {
        const self = {
            kind,
            calls: [] as ConnectCall[],
            connect: (target: FakeNode, output?: number, input?: number) => {
                self.calls.push({ target, output, input });
            },
            ...extra,
        } as FakeNode & T;
        return self;
    };
    const param = (value = 0) => ({ value, setTargetAtTime: vi.fn() });
    const context = {
        sampleRate: 48_000,
        currentTime: 0,
        createGain: () => node('gain', { gain: param(1) }),
        createChannelSplitter: (count: number) => node('splitter', { channelCount: count }),
        createChannelMerger: (count: number) => node('merger', { channelCount: count }),
        createBiquadFilter: () => node('biquad', { type: 'peaking', frequency: param() }),
    };
    return { context, node };
};

/** 从起点沿 connect 边走遍全图，按 kind 收集节点。 */
const reachableFrom = (start: FakeNode): FakeNode[] => {
    const seen = new Set<FakeNode>();
    const walk = (n: FakeNode) => {
        if (seen.has(n)) return;
        seen.add(n);
        n.calls.forEach(call => walk(call.target));
    };
    walk(start);
    return [...seen];
};

const graphNodes = (graph: ReturnType<typeof createVocalMixGraph>) => {
    const input = graph.input as unknown as FakeNode;
    const all = reachableFrom(input);
    return {
        all,
        gains: all.filter(n => n.kind === 'gain').map(asGain),
        filters: all.filter(n => n.kind === 'biquad').map(asFilter),
    };
};

describe('mixToGains', () => {
    it('maps the midpoint to a transparent passthrough (mid 1, side 1, no extras)', () => {
        expect(mixToGains(0.5)).toEqual({ mid: 1, side: 1, vocal: 0, sub: 0, trim: 1 });
    });

    it('maps the accompaniment end to: mid removed, side full, sub restored, no vocal boost, lifted', () => {
        expect(mixToGains(0)).toEqual({ mid: 0, side: 1, vocal: 0, sub: 1, trim: INSTRUMENTS_END_LIFT });
    });

    it('maps the vocals end to: mid pulled, side cut, vocal band boosted, no sub, trimmed', () => {
        expect(mixToGains(1)).toEqual({
            mid: 1 - MID_PULL_AT_VOCALS,
            side: 1 - SIDE_CUT_AT_VOCALS,
            vocal: VOCAL_BAND_BOOST,
            sub: 0,
            trim: VOCALS_END_TRIM,
        });
    });

    it('clamps out-of-range positions', () => {
        expect(mixToGains(-3)).toEqual(mixToGains(0));
        expect(mixToGains(7)).toEqual(mixToGains(1));
    });
});

describe('createVocalMixGraph', () => {
    it('starts transparent: mid/side unity, extras silent, side inverter negative, trim unity', () => {
        const { context } = createFakeContext();
        const graph = createVocalMixGraph(context as unknown as AudioContext);
        const { gains } = graphNodes(graph);
        // midSum 0.5、sidePos 0.5、sideNeg −0.5、midOut/sideSum/sideGain/input/output 各 1、
        // sideInv −1、vocalGain/subGain 0 —— 初始化的正确性全在这一组数值里。
        // 响度修整复用 output 节点，初始同为 1。
        const values = gains.map(g => g.gain.value).sort((a, b) => a - b);
        expect(values).toEqual([-1, -0.5, 0, 0, 0.5, 0.5, 1, 1, 1, 1, 1]);
    });

    it('routes the vocal band through highpass -> highpass -> lowpass, sub through two lowpasses', () => {
        const { context } = createFakeContext();
        const graph = createVocalMixGraph(context as unknown as AudioContext);
        const { filters } = graphNodes(graph);
        // 人声带通：两个 highpass + 一个 lowpass；低频支路：两个 lowpass。
        expect(filters.filter(f => f.type === 'highpass').length).toBe(2);
        expect(filters.filter(f => f.type === 'lowpass').length).toBe(3);
    });

    it('setMix writes smoothed values to all six variable gains (five branches + trim)', () => {
        const { context } = createFakeContext();
        const graph = createVocalMixGraph(context as unknown as AudioContext);
        const { gains } = graphNodes(graph);
        const called = () => gains.filter(g => g.gain.setTargetAtTime.mock.calls.length > 0);
        const lastValue = (g: GainLike) => g.gain.setTargetAtTime.mock.calls.at(-1)?.[0];

        graph.setMix(0);
        // p=0：mid→0、side→1、sideInv→−1、vocal→0、sub→1、trim→1.25
        expect(called().length).toBe(6);
        const lastValues = called().map(lastValue).sort((a: number, b: number) => a - b);
        expect(lastValues).toEqual([-1, 0, 0, 1, 1, INSTRUMENTS_END_LIFT]);

        graph.setMix(1);
        const values1 = called().map(lastValue).sort((a: number, b: number) => a - b);
        // p=1：mid→0.3、side→0.3、sideInv→−0.3、vocal→1.5、sub→0、trim→0.85
        expect(values1).toEqual([
            -(1 - SIDE_CUT_AT_VOCALS),
            0,
            1 - SIDE_CUT_AT_VOCALS,
            1 - MID_PULL_AT_VOCALS,
            VOCALS_END_TRIM,
            VOCAL_BAND_BOOST,
        ]);
    });
});

describe('registerVocalMixGraph / applyVocalMixPosition', () => {
    it('buffers the position until a graph registers, then applies it', () => {
        const { context } = createFakeContext();
        const graph = createVocalMixGraph(context as unknown as AudioContext);
        const { gains } = graphNodes(graph);

        applyVocalMixPosition(1);
        expect(gains.every(g => g.gain.setTargetAtTime.mock.calls.length === 0)).toBe(true);

        registerVocalMixGraph(graph);
        const boosted = gains.filter(g =>
            g.gain.setTargetAtTime.mock.calls.some(call => call[0] === VOCAL_BAND_BOOST));
        expect(boosted.length).toBe(1);
        registerVocalMixGraph(null);
    });

    it('treats null (collapsed UI) as the transparent midpoint', () => {
        const { context } = createFakeContext();
        const graph = createVocalMixGraph(context as unknown as AudioContext);
        registerVocalMixGraph(graph);
        const { gains } = graphNodes(graph);

        applyVocalMixPosition(null);
        const lastValues = gains
            .map(g => g.gain.setTargetAtTime.mock.calls.at(-1)?.[0])
            .filter(v => v !== undefined)
            .sort((a: number, b: number) => a - b);
        expect(lastValues).toEqual([-1, 0, 0, 1, 1, 1]);
        registerVocalMixGraph(null);
    });
});

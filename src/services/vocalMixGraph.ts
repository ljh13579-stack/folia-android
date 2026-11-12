// src/services/vocalMixGraph.ts
// 播放页「人声 / 伴奏」滑块的音频实现：中置声道提取 + 频段整形，不是 AI 分离。
//
// 流行歌混音把人声放在声像中央。把左右声道分解成 Mid = (L+R)/2（中央）和
// Side = (L−R)/2（两侧）后：
//   - 人声在 Mid 里，且大部分能量在 300Hz–8kHz；贝斯/底鼓也在 Mid 但低于 300Hz
//   - 乐器散布在 Side 和 Mid 两处
//
// 滑块四个增益分量（p ∈ [0,1]，0 底 = 伴奏，1 顶 = 人声）：
//   mid   = (1−(1−2p)⁺)·(1−0.7·(2p−1)⁺)  伴奏端整体移除中央；人声端再把全频中央压到
//                                        30%——贝斯/鼓/军鼓是中置乐器，全放行就混进人声
//   side  = 1 − 0.7·(2p−1)⁺               人声端把两侧（乐器）压到 30%
//   vocal = 1.5·(2p−1)⁺                   叠加「限带中央」——300Hz–8kHz 的 Mid 提 1.5 倍；
//                                        带内人声合计 0.3+1.5=1.8x，本体突出而乐器被压
//   sub   = (1−2p)⁺                       伴奏端把 150Hz 以下的低频从中央补回来，低音不丢
//   trim  = 1+0.25·(1−2p)⁺−0.15·(2p−1)⁺   输出响度修整：两端电平天然不平衡，
//                                        伴奏端抬 1.25、人声端压 0.85，中点恒 1
// p = 0.5 时 mid=1、side=1，Mid+Side 恰好恒等还原 L/R，中点完全透明。
//
// 已知局限（如实告知过用户）：单声道音源 Mid/Side 无从分解，效果差；人声混响尾巴
// 是立体声的，会留在伴奏端消不干净。AI 级分离（Demucs）模型几百 MB，WebView 跑
// 不动，这是折中方案。

/** 滑块位置映射出的增益分量，纯函数单独导出以便单测。 */
export type VocalMixGains = {
    /** 全频中央（Mid）直通增益：伴奏端降到 0。 */
    mid: number;
    /** 侧声道增益：人声端把乐器压到 30%。 */
    side: number;
    /** 限带中央（人声段）叠加增益。 */
    vocal: number;
    /** 低频中央（<150Hz）补偿增益，伴奏端补回低音。 */
    sub: number;
    /** 输出整体响度修整：两端电平天然不平衡，伴奏端抬、人声端压。 */
    trim: number;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 人声段限带中央的叠加倍率。 */
/** 人声段限带中央的叠加倍率：带内人声合计 mid(0.3)+vocal(1.5)=1.8x，本体突出。 */
export const VOCAL_BAND_BOOST = 1.5;
/** 人声段侧声道（乐器）的削减量：压到 30%。 */
export const SIDE_CUT_AT_VOCALS = 0.7;
/** 人声段全频中央的削减量：压到 30%——贝斯/鼓/军鼓是中置乐器，全放行就混进人声。 */
export const MID_PULL_AT_VOCALS = 0.7;
/** 人声段带通的下限/上限，低于它的贝斯/鼓留在带外。 */
export const VOCAL_BAND_HZ = { low: 300, high: 8000 } as const;
/** 伴奏端从中央补回的低频上限。 */
export const SUB_BAND_HZ = 150;
/** 伴奏端整体响度提升（侧声道能量天然比全混音低）。 */
export const INSTRUMENTS_END_LIFT = 1.25;
/** 人声端整体响度压减（带内 1.5 倍增益把电平抬高了）。 */
export const VOCALS_END_TRIM = 0.85;

export const mixToGains = (position: number): VocalMixGains => {
    const p = clamp01(position);
    const toVocals = Math.max(0, 2 * p - 1);
    const toInstruments = Math.max(0, 1 - 2 * p);
    return {
        // 伴奏端整体移除中央；人声端再把全频中央压到 30%。
        mid: (1 - toInstruments) * (1 - MID_PULL_AT_VOCALS * toVocals),
        side: 1 - SIDE_CUT_AT_VOCALS * toVocals,
        vocal: VOCAL_BAND_BOOST * toVocals,
        sub: toInstruments,
        // 两端电平天然不平衡：伴奏端抬、人声端压，中点恒 1。
        trim: 1 + (INSTRUMENTS_END_LIFT - 1) * toInstruments - (1 - VOCALS_END_TRIM) * toVocals,
    };
};

export type VocalMixGraph = {
    /** 接 fadeNode 的输出。 */
    input: GainNode;
    /** 接 analyser。 */
    output: GainNode;
    /**
     * 写滑块位置（0 伴奏 .. 1 人声），内部换算成四个增益分量并平滑过渡。
     * 常驻节点，passthrough 就是 setMix(0.5)。
     */
    setMix: (position: number) => void;
};

const SMOOTHING_TIME_CONSTANT = 0.05;

export const createVocalMixGraph = (context: AudioContext): VocalMixGraph => {
    const input = context.createGain();
    const output = context.createGain();
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);

    // Mid = (L+R)/2，Side = (L−R)/2。每个都是一路求和，靠正负增益区分。
    const midSum = context.createGain();
    midSum.gain.value = 0.5;
    const sidePos = context.createGain();
    sidePos.gain.value = 0.5;
    const sideNeg = context.createGain();
    sideNeg.gain.value = -0.5;
    const sideSum = context.createGain();

    // 四条可控支路：全频中央 / 限带中央（人声）/ 低频中央 / 侧声道。
    const midOut = context.createGain();
    const vocalHighpassA = context.createBiquadFilter();
    vocalHighpassA.type = 'highpass';
    vocalHighpassA.frequency.value = VOCAL_BAND_HZ.low;
    const vocalHighpassB = context.createBiquadFilter();
    vocalHighpassB.type = 'highpass';
    vocalHighpassB.frequency.value = VOCAL_BAND_HZ.low;
    const vocalLowpass = context.createBiquadFilter();
    vocalLowpass.type = 'lowpass';
    vocalLowpass.frequency.value = VOCAL_BAND_HZ.high;
    const vocalGain = context.createGain();
    const subLowpassA = context.createBiquadFilter();
    subLowpassA.type = 'lowpass';
    subLowpassA.frequency.value = SUB_BAND_HZ;
    const subLowpassB = context.createBiquadFilter();
    subLowpassB.type = 'lowpass';
    subLowpassB.frequency.value = SUB_BAND_HZ;
    const subGain = context.createGain();
    const sideGain = context.createGain();
    const sideInv = context.createGain();

    // 初始全部静默/恒等：midOut=1、sideGain=1 构成透明直通，其余 0。
    midOut.gain.value = 1;
    sideGain.gain.value = 1;
    sideInv.gain.value = -1;
    vocalGain.gain.value = 0;
    subGain.gain.value = 0;

    splitter.connect(midSum, 0);
    splitter.connect(midSum, 1);
    splitter.connect(sidePos, 0);
    splitter.connect(sideNeg, 1);
    sidePos.connect(sideSum);
    sideNeg.connect(sideSum);

    midSum.connect(midOut);
    midSum.connect(vocalHighpassA);
    vocalHighpassA.connect(vocalHighpassB);
    vocalHighpassB.connect(vocalLowpass);
    vocalLowpass.connect(vocalGain);
    midSum.connect(subLowpassA);
    subLowpassA.connect(subLowpassB);
    subLowpassB.connect(subGain);

    sideSum.connect(sideGain);
    sideSum.connect(sideInv);

    // 中央类支路同进两个声道；侧声道一正一负还原左右差。
    midOut.connect(merger, 0, 0);
    midOut.connect(merger, 0, 1);
    vocalGain.connect(merger, 0, 0);
    vocalGain.connect(merger, 0, 1);
    subGain.connect(merger, 0, 0);
    subGain.connect(merger, 0, 1);
    sideGain.connect(merger, 0, 0);
    sideInv.connect(merger, 0, 1);

    input.connect(splitter);
    merger.connect(output);

    const setMix = (position: number) => {
        const { mid, side, vocal, sub, trim } = mixToGains(position);
        const at = context.currentTime;
        midOut.gain.setTargetAtTime(mid, at, SMOOTHING_TIME_CONSTANT);
        sideGain.gain.setTargetAtTime(side, at, SMOOTHING_TIME_CONSTANT);
        sideInv.gain.setTargetAtTime(-side, at, SMOOTHING_TIME_CONSTANT);
        vocalGain.gain.setTargetAtTime(vocal, at, SMOOTHING_TIME_CONSTANT);
        subGain.gain.setTargetAtTime(sub, at, SMOOTHING_TIME_CONSTANT);
        // 响度修整写在 output 上：可视化器接在下游，画出来的就是实际听到的电平。
        output.gain.setTargetAtTime(trim, at, SMOOTHING_TIME_CONSTANT);
    };

    return { input, output, setMix };
};

// ---- 模块级单例注册 --------------------------------------------------------
// 图在 buildPlaybackGraph 里建（生命周期跟着 AudioContext），UI 在任意时刻调用
// applyVocalMixPosition。两边不互相引用，所以走这个注册表：晚到的一方存下待应用值，
// 先到的立即生效。position 为 null 表示 UI 已收起，回到中点（原声）。

let activeGraph: VocalMixGraph | null = null;
let pendingPosition: number | null = null;

export const registerVocalMixGraph = (graph: VocalMixGraph | null): void => {
    activeGraph = graph;
    if (graph && pendingPosition !== null) {
        graph.setMix(pendingPosition);
    }
};

/** UI 侧唯一入口。position ∈ [0,1]，null = 收起（恢复原声）。 */
export const applyVocalMixPosition = (position: number | null): void => {
    pendingPosition = position;
    if (activeGraph) {
        activeGraph.setMix(position ?? 0.5);
    }
};

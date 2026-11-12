// Folia Android 适配层：网易云 weapi/eapi/api 加密的浏览器端移植
// 移植自 @neteasecloudmusicapienhanced/api 的 util/crypto.js（Node 版用 node-forge 做 RSA，
// 这里改用原生 BigInt 做无填充的模幂运算；AES/MD5 用 crypto-js，与 Node 版完全同算法）。
import CryptoJS from 'crypto-js';

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const LINUXAPI_KEY = 'rFgB&h#%2?^eDg:Q';
const EAPI_KEY = 'e82ckenh8dichen8';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// weapi RSA 公钥（PEM 中的 modulus 与 exponent，Node 版用 forge 解析，这里直接内联）
// -----BEGIN PUBLIC KEY-----
// MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6s
// XqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgT
// z+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
// -----END PUBLIC KEY-----
const WEAPI_MODULUS = BigInt(
  '0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7',
);
const WEAPI_EXPONENT = BigInt(0x10001);

const aesEncrypt = (
  text: string,
  mode: 'cbc' | 'ecb',
  key: string,
  iv: string,
  format: 'base64' | 'hex' = 'base64',
): string => {
  const encrypted = CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(text), CryptoJS.enc.Utf8.parse(key), {
    iv: iv ? CryptoJS.enc.Utf8.parse(iv) : undefined,
    mode: mode === 'cbc' ? CryptoJS.mode.CBC : CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  if (format === 'base64') {
    return encrypted.toString();
  }
  return encrypted.ciphertext.toString().toUpperCase();
};

const aesDecryptEcbHex = (cipherHex: string, key: string): string => {
  const bytes = CryptoJS.AES.decrypt(
    { ciphertext: CryptoJS.enc.Hex.parse(cipherHex) } as CryptoJS.lib.CipherParams,
    CryptoJS.enc.Utf8.parse(key),
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 },
  );
  return bytes.toString(CryptoJS.enc.Utf8);
};

// forge 的 'NONE' 填充 RSA 加密 = 原始模幂运算；输入字节序为大端，输出 256 位十六进制
const rsaEncryptNoPad = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  const m = BigInt('0x' + (hex || '0'));
  const c = m ** WEAPI_EXPONENT % WEAPI_MODULUS;
  return c.toString(16).padStart(256, '0');
};

export type WeapiResult = { params: string; encSecKey: string };

/** weapi 加密：AES-CBC 双重加密 + RSA 加密随机密钥 */
export const weapi = (object: unknown): WeapiResult => {
  const text = JSON.stringify(object);
  let secretKey = '';
  for (let i = 0; i < 16; i++) {
    secretKey += BASE62.charAt(Math.round(Math.random() * 61));
  }
  return {
    params: aesEncrypt(aesEncrypt(text, 'cbc', PRESET_KEY, IV), 'cbc', secretKey, IV),
    encSecKey: rsaEncryptNoPad(secretKey.split('').reverse().join('')),
  };
};

/** linuxapi 加密：AES-ECB，输出大写 hex */
export const linuxapi = (object: unknown): { eparams: string } => {
  const text = JSON.stringify(object);
  return { eparams: aesEncrypt(text, 'ecb', LINUXAPI_KEY, '', 'hex') };
};

/** eapi 加密：MD5 摘要拼接后 AES-ECB，输出大写 hex */
export const eapi = (url: string, object: unknown): { params: string } => {
  const text = typeof object === 'object' ? JSON.stringify(object) : String(object);
  const message = `nobody${url}use${text}md5forencrypt`;
  const digest = CryptoJS.MD5(message).toString();
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return { params: aesEncrypt(data, 'ecb', EAPI_KEY, '', 'hex') };
};

/** eapi 响应解密（请求 e_r=true 时服务端返回加密响应） */
export const eapiResDecrypt = (encryptedHex: string): unknown => {
  try {
    const decrypted = aesDecryptEcbHex(encryptedHex, EAPI_KEY);
    return JSON.parse(decrypted);
  } catch (error) {
    console.warn('[folia-mobile] eapiResDecrypt failed:', error);
    return null;
  }
};

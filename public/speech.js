// @ts-check
/**
 * speech.js —— 音效与朗读（刷词页）
 *
 * 从 app.js 拆出来的理由：这一块只依赖 `state.settings`（音效开关 / 语速）和朗读按钮的
 * class 切换，跟出题、渲染、同步完全无关，是最干净的一刀。
 *
 * 两个平台坑（都已在代码里处理，别"简化"掉）：
 *  · iOS Safari 要求朗读发生在用户手势里，所以 `speak()` 返回**是否真的开始播放**，
 *    调用方据此给降级提示，而不是静默失败；
 *  · `getVoices()` 首次常返回空数组，必须等 `voiceschanged` 事件，并留 1.5s 兜底超时。
 */
import { state } from "./state.js";

let audioCtx = /** @type {AudioContext|null} */ (null);
let voices = /** @type {SpeechSynthesisVoice[]} */ ([]);

/** @param {number} freq @param {number} dur @param {OscillatorType} [type] */
export function tone(freq, dur, type = "sine") {
  if (!state.settings.sfx) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.16, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch {
    /* 音频不可用不影响学习 */
  }
}

export const sfxOk = () => {
  tone(880, 0.08);
  window.setTimeout(() => tone(1180, 0.1), 90);
};

export const sfxBad = () => {
  tone(300, 0.14, "square");
  window.setTimeout(() => tone(200, 0.18, "square"), 140);
};

export function loadVoices() {
  return new Promise((resolve) => {
    const list = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (list && list.length) {
      voices = list;
      resolve(voices);
      return;
    }
    if (!window.speechSynthesis) {
      resolve([]);
      return;
    }
    window.speechSynthesis.addEventListener(
      "voiceschanged",
      () => {
        voices = window.speechSynthesis.getVoices();
        resolve(voices);
      },
      { once: true }
    );
    window.setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1500);
  });
}

/**
 * 朗读单词。返回是否真的开始播放（iOS 需要用户手势，未播放时调用方给降级提示）
 * @param {string} word
 */
export async function speak(word) {
  if (!state.settings.speech || !window.speechSynthesis || !word) return false;
  try {
    if (!voices.length) await loadVoices();
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = "en-US";
    utter.rate = state.settings.rate;
    const preferred =
      voices.find((v) => v.lang === "en-US") || voices.find((v) => v.lang?.startsWith("en")) || null;
    if (preferred) utter.voice = preferred;
    const btn = state.dom.speakBtn;
    utter.onstart = () => btn?.classList.add("speaking");
    utter.onend = () => btn?.classList.remove("speaking");
    utter.onerror = () => btn?.classList.remove("speaking");
    window.speechSynthesis.speak(utter);
    btn?.classList.remove("unsupported");
    return true;
  } catch {
    return false;
  }
}

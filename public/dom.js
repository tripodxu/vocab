// @ts-check
/**
 * dom.js —— 刷词页 DOM 句柄缓存（从 app.js 抽出，纯"按 id 取节点"）
 *
 * 为什么单独一个模块：app.js 已 4100 行，任何后续拆分（sync / render / brush）都要先共享
 * 同一份句柄表；句柄表放这里，app.js 各处 `const dom = state.dom` 的用法一行都不用改。
 * 约束：只做查找与缓存，**不放任何业务判断**；Node 端 import 本模块不会碰 document
 * （$ 只在函数体里调用），所以 check.mjs 的"模块可导入"检查能通过。
 */
import { $ } from "./ui.js";
import { state } from "./state.js";

export function cacheDom() {
  const dom = state.dom;
  dom.brandSub = $("#brandSub");
  dom.syncBtn = $("#syncBtn");
  dom.goal = $("#goalRing");
  dom.goalNum = $("#goalNum");
  dom.timerText = $("#timerText");
  dom.moreBtn = $("#moreBtn");
  dom.quickMenu = $("#quickMenu");
  dom.menuBtn = $("#menuBtn");
  dom.chapterBtn = $("#chapterBtn");
  dom.meta = $("#sessionMeta");
  dom.progressFill = $("#progressFill");
  dom.stageHead = $("#stageHead");
  dom.loading = $("#loadingCard");
  dom.loadingText = $("#loadingText");
  dom.loadError = $("#loadErrorCard");
  dom.loadErrorText = $("#loadErrorText");
  dom.retryBtn = $("#retryBtn");
  dom.errorChapterBtn = $("#errorChapterBtn");
  dom.body = $("#stageBody");
  dom.practiceSeg = $("#practiceSeg");
  dom.modeSeg = $("#modeSeg");
  dom.promptCn = $("#promptCn");
  dom.promptAudio = $("#promptAudio");
  dom.promptHint = $("#promptHint");
  dom.speakBtn = $("#speakBtn");
  dom.promptWord = $("#promptWord");
  dom.promptWordEn = $("#promptWordEn");
  dom.promptPhonetic = $("#promptPhonetic");
  dom.promptSpeak = $("#promptSpeak");
  dom.slots = $("#slots");
  dom.slotsWrap = $("#slotsWrap");
  dom.spellArea = $("#spellArea");
  dom.choiceArea = $("#choiceArea");
  dom.options = $("#options");
  dom.optionNodes = []; // renderOptions 的增量节点缓存（换题才重建）
  dom.optionsFor = null; // 当前缓存对应的题目对象
  dom.slotsFor = null; // 当前槽位对应的词（换词才重放入场动效）
  dom.choiceHint = $("#choiceHint");
  dom.quizNote = $("#quizNote");
  dom.quizNoteHead = $("#quizNoteHead");
  dom.quizNoteList = $("#quizNoteList");
  dom.quizNoteFoot = $("#quizNoteFootText");
  dom.tapHint = $("#tapHint");
  dom.answerInput = $("#answerInput");
  dom.feedback = $("#feedback");
  dom.example = $("#example");
  dom.exampleEn = $("#exampleEn");
  dom.exampleCn = $("#exampleCn");
  dom.primaryBtn = $("#primaryBtn");
  dom.skipBtn = $("#skipBtn");
  dom.starBtn = $("#starBtn");
  dom.repeatBtn = $("#repeatBtn");
  dom.prevBtn = $("#prevBtn");
  dom.resetQBtn = $("#resetQBtn");
  dom.dontBtn = $("#dontBtn");
  dom.resetBtn = $("#resetBtn");
  dom.timerBtn = $("#timerBtn");
  dom.timerChip = $("#timerChip");
  dom.hintPick = $("#hintPick");
  dom.hintSelect = /** @type {HTMLSelectElement} */ ($("#hintSelect"));
  dom.reportBtn = $("#reportBtn"); // 曾漏缓存 → 辨析卡上的「报错」入口从未出现过（第五期遗留，第六期线上审查抓出）
  dom.reviewBanner = $("#reviewBanner");
  dom.reviewExit = $("#reviewExit");
}

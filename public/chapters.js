/**
 * 章节清单 —— 由 scripts/convert-data.mjs 生成，请勿手改。
 * 新增章节：把 data-N.js 放进 public/ 并在 scripts/convert-data.mjs 的 CHAPTER_META 里补一条，然后 npm run build:data
 */
export const CHAPTERS = [
  {
    "id": 1,
    "title": "自然地理",
    "emoji": "🌍",
    "count": 227
  },
  {
    "id": 2,
    "title": "植物研究",
    "emoji": "🌱",
    "count": 130
  },
  {
    "id": 3,
    "title": "动物保护",
    "emoji": "🐾",
    "count": 168
  },
  {
    "id": 4,
    "title": "太空探索",
    "emoji": "🚀",
    "count": 70
  },
  {
    "id": 5,
    "title": "学校教育",
    "emoji": "🎓",
    "count": 401
  },
  {
    "id": 6,
    "title": "科技文明",
    "emoji": "🔬",
    "count": 122
  },
  {
    "id": 7,
    "title": "文化历史",
    "emoji": "📜",
    "count": 79
  },
  {
    "id": 8,
    "title": "语言演化",
    "emoji": "🗣️",
    "count": 68
  },
  {
    "id": 9,
    "title": "文化娱乐",
    "emoji": "🎭",
    "count": 175
  },
  {
    "id": 10,
    "title": "物品材料",
    "emoji": "🧱",
    "count": 135
  },
  {
    "id": 11,
    "title": "时尚潮流",
    "emoji": "👗",
    "count": 91
  },
  {
    "id": 12,
    "title": "饮食健康",
    "emoji": "🥗",
    "count": 172
  },
  {
    "id": 13,
    "title": "建筑场所",
    "emoji": "🏗️",
    "count": 132
  },
  {
    "id": 14,
    "title": "交通旅行",
    "emoji": "✈️",
    "count": 139
  },
  {
    "id": 15,
    "title": "国家政府",
    "emoji": "🏛️",
    "count": 135
  },
  {
    "id": 16,
    "title": "社会经济",
    "emoji": "💹",
    "count": 171
  },
  {
    "id": 17,
    "title": "法律法规",
    "emoji": "⚖️",
    "count": 101
  },
  {
    "id": 18,
    "title": "沙场争锋",
    "emoji": "⚔️",
    "count": 186
  },
  {
    "id": 19,
    "title": "社会角色",
    "emoji": "👥",
    "count": 124
  },
  {
    "id": 20,
    "title": "行为动作",
    "emoji": "🏃",
    "count": 268
  },
  {
    "id": 21,
    "title": "身心健康",
    "emoji": "💚",
    "count": 417
  },
  {
    "id": 22,
    "title": "时间日期",
    "emoji": "🕰️",
    "count": 57
  }
];

export const TOTAL_WORDS = 3568;

export const CHAPTER_BY_ID = new Map(CHAPTERS.map((c) => [c.id, c]));

export function chapterTitle(id) {
  const c = CHAPTER_BY_ID.get(Number(id));
  return c ? `第${c.id}章 · ${c.title}` : `第${id}章`;
}

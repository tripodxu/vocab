// @ts-check
/**
 * star-sync.js —— 生词本的本机队列 + 云端 LWW 同步
 *
 * 两页共用这一份实现：
 *   - app.js：刷词页的生词按钮/生词本
 *   - lecture.js：讲义卡片/详情里的生词按钮
 *
 * 本机同时保存活动列表（vocab:stars:*）和带墓碑的记录表（vocab:star-records:*）。
 * 云端接口只接收记录表，因此“取消生词”也能作为 starred=false 的墓碑传播到其它设备。
 */
import Auth from "./vocab-auth.js";
import {
  activeFromRecords,
  loadActiveStars,
  loadStarRecords,
  mergeStarRecords,
  normalizeActiveStars,
  normalizeStarRecords,
  recordKey,
  recordsForPush,
  recordsFromActive,
  replaceActiveStars,
  starRecordsKey,
  saveStarState,
  setStar,
} from "./star-store.js";

const CHUNK = 500;
const FLUSH_MAX_WAIT = 4000;

/**
 * @param {{
 *   getUserKey: () => string,
 *   onChange?: (active: Record<string, number[]>) => void,
 *   auth?: any,
 *   storage?: any
 * }} opts
 */
export function createStarSync(opts) {
  const getUserKey = opts.getUserKey;
  const onChange = opts.onChange || (() => {});
  const auth = opts.auth || Auth;
  const storageOverride = opts.storage;
  /** @type {Set<string>} */
  const dirty = new Set();
  let timer = 0;
  let firstDirtyAt = 0;
  /** @type {{ generation: number, userKey: string } | null} */
  let inFlight = null;
  /** @type {{ generation: number, userKey: string, promise: Promise<boolean> } | null} */
  let pullInFlight = null;
  let backoff = 0;
  let lastError = /** @type {string|null} */ (null);
  let generation = 0;
  /**
   * Values which could not be written to the browser store.  They are kept per
   * user namespace and intentionally survive reset(), so a logout or a tab
   * close cannot discard the only copy of a pending star.
   * @type {Map<string, string>}
   */
  const memoryValues = new Map();

  function storageKey(userKey, key) {
    return `${userKey}\u0000${key}`;
  }

  /**
   * A small overlay around localStorage.  Reads prefer the overlay; failed
   * writes are retained there.  This also makes the module deterministic in
   * tests and keeps the rest of the code using the normal star-store API.
   */
  function storageFor(userKey) {
    const base = storageOverride !== undefined ? storageOverride : (typeof localStorage !== "undefined" ? localStorage : null);
    return {
      getItem(key) {
        const memoryKey = storageKey(userKey, key);
        if (memoryValues.has(memoryKey)) return memoryValues.get(memoryKey) ?? null;
        try {
          return base?.getItem(key) ?? null;
        } catch {
          return null;
        }
      },
      setItem(key, value) {
        const memoryKey = storageKey(userKey, key);
        try {
          if (!base) throw new Error("storage unavailable");
          base.setItem(key, value);
          memoryValues.delete(memoryKey);
          return true;
        } catch {
          memoryValues.set(memoryKey, String(value));
          return false;
        }
      },
      removeItem(key) {
        const memoryKey = storageKey(userKey, key);
        try {
          if (base) base.removeItem(key);
          memoryValues.delete(memoryKey);
        } catch {
          // Keep the overlay value if the underlying store cannot remove it.
        }
      },
    };
  }

  function notify(active) {
    try {
      onChange(active);
    } catch {
      // UI 尚未完成初始化时，状态仍已经安全写入本机。
    }
  }

  function markDirty(chapter, word) {
    dirty.add(recordKey(chapter, word));
    schedule();
  }

  function markKeysDirty(keys) {
    for (const key of keys) dirty.add(key);
    schedule();
  }

  /** 登录/切换命名空间时，把本机已有记录全部排队，随后由 pull 的 LWW 结果淘汰旧值。 */
  function markAllDirty() {
    const records = currentRecords();
    markKeysDirty(Object.keys(records));
    return Object.keys(records).length;
  }

  /**
   * 普通改动走防抖（最多等待 FLUSH_MAX_WAIT）；失败重试则使用完整 backoff，
   * 不能再次被 firstDirtyAt 截成 0ms，否则网络失败时会变成零延迟死循环。
   * @param {number} delay
   * @param {boolean} retry
   */
  function schedule(delay = 800, retry = false) {
    if (!auth.isLoggedIn()) return;
    clearTimeout(timer);
    if (retry) {
      timer = setTimeout(() => void flush(), Math.max(0, delay));
      return;
    }
    if (!firstDirtyAt) firstDirtyAt = Date.now();
    const elapsed = Date.now() - firstDirtyAt;
    const capped = Math.min(delay, Math.max(0, FLUSH_MAX_WAIT - elapsed));
    timer = setTimeout(() => void flush(), capped);
  }

  /** 把 guest 的活动列表/记录并入目标账号；只允许由调用方决定是否执行。 */
  function mergeGuestInto(targetUserKey) {
    const guestStore = storageFor("guest");
    const targetStore = storageFor(targetUserKey);
    const guestActive = loadActiveStars("guest", guestStore);
    const guestRecords = loadStarRecords("guest", guestStore, guestActive);
    const targetActive = loadActiveStars(targetUserKey, targetStore);
    const targetRecords = loadStarRecords(targetUserKey, targetStore, targetActive);
    const merged = mergeStarRecords(targetRecords, guestRecords);
    const active = activeFromRecords(merged);
    saveStarState(targetUserKey, active, merged, targetStore);
    markKeysDirty([
      ...Object.keys(guestRecords),
      ...Object.keys(targetRecords).filter((key) => targetRecords[key].updatedAt === 0),
    ]);
    notify(active);
  }

  function currentRecords(userKey = getUserKey(), fallbackChapter = 1) {
    const store = storageFor(userKey);
    return loadStarRecords(userKey, store, loadActiveStars(userKey, store, fallbackChapter));
  }

  function set(chapter, word, starred) {
    const userKey = getUserKey();
    const result = setStar(userKey, chapter, word, starred, storageFor(userKey));
    markDirty(chapter, word);
    notify(result.active);
    return result;
  }

  function replace(nextActive) {
    const userKey = getUserKey();
    const store = storageFor(userKey);
    const before = loadStarRecords(userKey, store);
    const result = replaceActiveStars(userKey, nextActive, store);
    const changed = Object.keys(result.records).filter((key) => {
      const old = before[key];
      const now = result.records[key];
      return !old || old.starred !== now.starred || old.updatedAt !== now.updatedAt;
    });
    markKeysDirty(changed);
    notify(result.active);
    return result;
  }

  /** 合并备份/导入得到的记录，保留 LWW 与墓碑。 */
  function merge(value) {
    const userKey = getUserKey();
    const store = storageFor(userKey);
    const before = loadStarRecords(userKey, store);
    const records = mergeStarRecords(before, value);
    const active = activeFromRecords(records);
    saveStarState(userKey, active, records, store);
    const changed = Object.keys(records).filter((key) => {
      const old = before[key];
      const now = records[key];
      return !old || old.starred !== now.starred || old.updatedAt !== now.updatedAt;
    });
    markKeysDirty(changed);
    notify(active);
    return { active, records };
  }

  /** 合并只有活动列表的旧备份；已有记录/墓碑仍按 LWW 保留。 */
  function mergeActive(value) {
    return merge(recordsFromActive(value, 0));
  }

  /**
   * 拉取全量云端记录并合并。请求期间用户可能继续点星，因此响应回来后重新读取
   * 本机记录，不用请求开始时的旧快照覆盖新操作。
   */
  async function pull() {
    const run = generation;
    const userKey = getUserKey();
    if (pullInFlight && pullInFlight.generation === run && pullInFlight.userKey === userKey) {
      return pullInFlight.promise;
    }
    const promise = (async () => {
      if (!auth.isLoggedIn()) return false;
      clearTimeout(timer);
      timer = 0;
      const data = await auth.pullStars();
      const stale = run !== generation || getUserKey() !== userKey || !auth.isLoggedIn();
      if (stale) {
        if (run === generation && auth.isLoggedIn() && dirty.size) schedule(1000, true);
        return false;
      }
      if (!data) {
        lastError = "生词云端拉取失败";
        return false;
      }
      const store = storageFor(userKey);
      const currentLocal = loadStarRecords(userKey, store);
      const remote = normalizeStarRecords(data.stars || {});
      const merged = mergeStarRecords(currentLocal, remote);
      const active = activeFromRecords(merged);
      saveStarState(userKey, active, merged, store);
      lastError = null;

      // Reconcile every local key, not just keys already dirty in this tab.
      // This recovers a writer tab which closed before its debounce timer fired.
      for (const [key, local] of Object.entries(currentLocal)) {
        const remoteItem = remote[key];
        const localIsUnknown = local.updatedAt === 0;
        if (localIsUnknown || !remoteItem) {
          dirty.add(key);
          continue;
        }
        if (local.updatedAt > remoteItem.updatedAt) {
          dirty.add(key);
        } else if (remoteItem.updatedAt > local.updatedAt) {
          dirty.delete(key);
        } else if (local.starred === remoteItem.starred) {
          dirty.delete(key);
        } else if (local.starred === false) {
          // Equal timestamps: deletion wins locally as well as on the server.
          dirty.add(key);
        } else {
          dirty.delete(key);
        }
      }
      notify(active);
      if (dirty.size) schedule();
      else firstDirtyAt = 0;
      return true;
    })();
    const entry = { generation: run, userKey, promise };
    pullInFlight = entry;
    try {
      return await promise;
    } finally {
      if (pullInFlight === entry) pullInFlight = null;
    }
  }

  /**
   * 分块上传。上传成功后不直接丢弃 dirty，而是再拉一次全量：这样服务端 LWW
   * 拒绝的旧写入会被远端新值纠正，且本机上传期间发生的同词修改不会被误删。
   */
  async function flush() {
    if (!auth.isLoggedIn()) return false;
    if (inFlight) {
      schedule(600, true);
      return false;
    }
    const runToken = { generation, userKey: getUserKey() };
    inFlight = runToken;
    const userKey = runToken.userKey;
    const store = storageFor(userKey);
    let failed = false;
    try {
      let keys = [...dirty];
      if (!keys.length) {
        firstDirtyAt = 0;
        return true;
      }
      let records = currentRecords(userKey);
      if (keys.some((key) => records[key]?.updatedAt === 0)) {
        const canonical = await pull();
        if (!canonical) failed = true;
        if (failed) throw new Error("canonical star pull failed");
        keys = [...dirty];
        records = currentRecords(userKey);
      }
      const snapshots = new Map(
        keys
          .map((key) => [key, records[key]])
          .filter(([, item]) => Boolean(item))
      );
      if (snapshots.size !== keys.length) {
        // Never clear a dirty key merely because persistence/readback failed.
        throw new Error("star record unavailable");
      }
      const changes = recordsForPush(Object.fromEntries(snapshots));
      if (!changes.length) throw new Error("no valid star changes");

      for (let i = 0; i < changes.length; i += CHUNK) {
        const slice = changes.slice(i, i + CHUNK);
        const res = await auth.pushStars(slice);
        if (runToken.generation !== generation || getUserKey() !== userKey || !res || !res.ok || !auth.isLoggedIn()) {
          failed = true;
          break;
        }
      }
      if (!failed) {
        // 成功响应只说明请求被接受；全量 pull 负责确认最终 canonical LWW 值。
        const pulled = await pull();
        if (!pulled) failed = true;
      }
    } catch {
      failed = true;
    } finally {
      if (inFlight === runToken) inFlight = null;
    }

    if (runToken.generation !== generation || getUserKey() !== userKey) return false;
    if (failed) {
      lastError = "生词同步失败";
      backoff = Math.min(30000, Math.max(1000, backoff * 2));
      schedule(backoff, true);
      return false;
    }
    lastError = null;
    backoff = 0;
    if (!dirty.size) firstDirtyAt = 0;
    return true;
  }

  function activeFor(fallbackChapter = 1) {
    const userKey = getUserKey();
    const store = storageFor(userKey);
    const records = loadStarRecords(userKey, store, loadActiveStars(userKey, store, fallbackChapter));
    const memory = memoryValues.get(storageKey(userKey, starRecordsKey(userKey)));
    if (memory) {
      try {
        return activeFromRecords(mergeStarRecords(records, JSON.parse(memory)), fallbackChapter);
      } catch {
        // fall through to the normalized local records
      }
    }
    return activeFromRecords(records, fallbackChapter);
  }

  function reset() {
    generation++;
    clearTimeout(timer);
    timer = 0;
    firstDirtyAt = 0;
    // 旧请求仍可能完成，但它不再拥有这个槽位，不能覆盖新账号的 inFlight 状态。
    inFlight = null;
    pullInFlight = null;
    backoff = 0;
    lastError = null;
    dirty.clear();
    // Do not clear memoryValues: it is the fallback for unsaved local records.
  }

  return {
    active: activeFor,
    records: currentRecords,
    set,
    replace,
    merge,
    mergeActive,
    pull,
    flush,
    mergeGuestInto,
    reset,
    markAllDirty,
    dirtySize: () => dirty.size,
    lastError: () => lastError,
    markDirty,
  };
}

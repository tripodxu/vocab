// @ts-check
/**
 * Shared session identity guard.  Async callbacks capture a token containing
 * the local namespace and auth revision; continuations must still match both
 * before touching page state.
 */
export function createSessionGuard() {
  let epoch = 0;
  let userKey = "guest";
  let authRevision = 0;

  function begin() {
    return Object.freeze({ epoch, userKey, authRevision });
  }

  function capture(nextUserKey, nextAuthRevision) {
    return Object.freeze({
      epoch,
      userKey: String(nextUserKey || "guest"),
      authRevision: Number(nextAuthRevision) || 0,
    });
  }

  function transition(nextUserKey, nextAuthRevision = authRevision) {
    epoch++;
    userKey = String(nextUserKey || "guest");
    authRevision = Number(nextAuthRevision) || 0;
    return begin();
  }

  function isCurrent(token, expectedUserKey, expectedAuthRevision) {
    return Boolean(
      token &&
        token.epoch === epoch &&
        token.userKey === userKey &&
        token.authRevision === authRevision &&
        userKey === String(expectedUserKey || "guest") &&
        authRevision === (Number(expectedAuthRevision) || 0)
    );
  }

  return { begin, capture, transition, isCurrent, snapshot: () => ({ epoch, userKey, authRevision }) };
}

// 명세 BR-D3-04 — 같은 목록 범위 안에 동일 이름이 있으면 "(N)" 접미사를 붙인다.
// 개인 채팅(본인 채팅 범위)과 팀 채팅방(프로젝트 팀 채팅 범위)이 같이 쓴다.
// 한쪽에만 두면 같은 규칙이 두 벌이 되고 예시("로그인 관련 질문 (2)")가 갈린다.

// 명세 BR-D3-01.
export const CHAT_NAME_MAX_LENGTH = 100;

// 접미사가 붙어 한도를 넘으면 앞을 자른다. 자르지 않으면 저장이 실패하는데,
// 이름을 바꾸려다 실패하는 것보다 조금 잘린 이름이 낫다.
const withSuffix = (base: string, n: number): string => {
  const suffix = ` (${n})`;
  const room = CHAT_NAME_MAX_LENGTH - suffix.length;
  return `${base.slice(0, Math.max(0, room)).trimEnd()}${suffix}`;
};

// taken 은 같은 범위에 이미 있는 이름들이다. 자기 자신은 부르는 쪽에서 빼고 넘긴다 —
// 이름을 그대로 두는 변경이 "(2)"가 붙어 돌아오면 안 된다.
export const resolveUniqueChatName = (desired: string, taken: readonly string[]): string => {
  const base = desired.trim();
  const used = new Set(taken.map((name) => name.trim()));

  if (!used.has(base)) {
    return base.slice(0, CHAT_NAME_MAX_LENGTH);
  }

  // 2부터 올린다. 명세 예시가 "로그인 관련 질문 (2)"다.
  for (let n = 2; n <= used.size + 2; n += 1) {
    const candidate = withSuffix(base, n);
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  // used.size + 2 까지 갔는데도 비어 있는 번호가 없을 수는 없다(비둘기집).
  // 그래도 타입상 반환이 필요하므로 마지막 번호를 쓴다.
  return withSuffix(base, used.size + 2);
};

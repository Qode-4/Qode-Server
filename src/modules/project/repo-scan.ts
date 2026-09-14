import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

// ⚠ Qode-python app/parsing/filters.py 의 규칙을 옮겨 온 것이다.
// 한쪽만 바뀌면 "인덱싱 대상"의 뜻이 두 서비스에서 갈라지고, 서버가 "코드가 없다"고
// 막은 레포를 파이썬은 정상 인덱싱하거나 그 반대가 된다.
//
// ponytail: 규칙을 두 벌 들고 있다. 한쪽으로 모으려면 파이썬이 /index 응답으로 돌려주는
// chunks_created 를 서버가 읽어야 하는데, 그러려면 인덱싱을 한 번 돌린 뒤에야 "빈 레포"를
// 알 수 있다. 임베딩 비용을 쓰고 나서 거절하는 셈이라 지금은 미리 세는 쪽을 택했다.
export const ALLOWED_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs", ".rb",
  ".yml", ".yaml", ".json", ".sql",
];

export const EXCLUDE_DIRS = [
  "node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__",
];

export const EXCLUDE_PATTERNS = [
  ".env", ".env.*", "credentials.*", "*.lock", "package-lock.json", "*.min.js", "*.map",
];

// 명세 A-4. 초과하면 동기화를 실패시킨다.
export const MAX_REPO_BYTES = 500 * 1024 * 1024;
export const MAX_INDEX_FILES = 10_000;

// fnmatch 중 이 목록이 쓰는 것은 * 뿐이다. 정규식으로 바꿔 그것만 처리한다.
const matchesPattern = (name: string, pattern: string): boolean => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
};

export const isIndexTarget = (fileName: string): boolean => {
  const dot = fileName.lastIndexOf(".");
  const ext = dot === -1 ? "" : fileName.slice(dot).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return false;
  }
  return !EXCLUDE_PATTERNS.some((pattern) => matchesPattern(fileName, pattern));
};

export type RepoScan = {
  // 인덱싱 대상 파일 수. 0이면 코드가 없는 레포다.
  fileCount: number;
  // 제외 디렉터리를 뺀 실제 코드 크기. .git 은 인덱싱 대상이 아니라 여기서 빠진다.
  byteSize: number;
};

// 클론된 작업 트리를 한 번 훑어 크기와 인덱싱 대상 수를 센다.
export const scanRepository = async (root: string): Promise<RepoScan> => {
  let fileCount = 0;
  let byteSize = 0;

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.includes(entry.name)) {
          continue;
        }
        await walk(resolve(dir, entry.name));
        continue;
      }

      // 심볼릭 링크는 따라가지 않는다. 순환 링크가 있으면 스캔이 끝나지 않는다.
      if (!entry.isFile()) {
        continue;
      }

      const info = await stat(resolve(dir, entry.name));
      byteSize += info.size;
      if (isIndexTarget(entry.name)) {
        fileCount += 1;
      }
    }
  };

  await walk(root);
  return { fileCount, byteSize };
};

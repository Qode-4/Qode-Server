type StartIndexJobInput = {
  projectId: string;
  syncJobId: string;
};

export type IndexJobResult = {
  status: string;
  chunksCreated: number;
};

// 파이썬 /index 는 저장소 전체를 다시 임베딩한다 — 9/16 실측 28초. git sync 와 같은 상한을 둔다
const INDEX_TIMEOUT_MS = 10 * 60 * 1000;

export class AnalysisServerClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      internalToken: string;
      timeoutMs?: number;
    }
  ) {}

  async checkHealth(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    const endpoint = new URL("/health", this.options.baseUrl);

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          "X-Qode-Internal-Token": this.options.internalToken,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Analysis server health check failed: ${response.status} ${body.slice(0, 500)}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Analysis server health check timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async startIndexJob(input: StartIndexJobInput): Promise<IndexJobResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INDEX_TIMEOUT_MS);
    const endpoint = new URL("/index", this.options.baseUrl);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Qode-Internal-Token": this.options.internalToken,
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `Analysis server index request failed: ${response.status} ${body.slice(0, 500)}`
        );
      }
      // 열린 과제 13-6. 본문을 버리면 실패가 성공으로 처리된다
      const parsed = JSON.parse(body) as { status?: string; chunks_created?: number };
      if (parsed.status !== "completed") {
        throw new Error(`Analysis server index failed: ${body.slice(0, 500)}`);
      }
      return { status: parsed.status, chunksCreated: parsed.chunks_created ?? 0 };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Analysis server index request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

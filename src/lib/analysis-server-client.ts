type StartIndexJobInput = {
  projectId: string;
  syncJobId: string;
};

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

  async startIndexJob(input: StartIndexJobInput): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
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

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Analysis server index request failed: ${response.status} ${body.slice(0, 500)}`
        );
      }
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

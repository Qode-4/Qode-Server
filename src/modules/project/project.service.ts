import type { ProjectRepository } from "./project.repository.js";
import type { CreateProjectInput } from "./project.types.js";

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  list() {
    return this.repository.list();
  }

  create(input: CreateProjectInput) {
    return this.repository.create(input);
  }
}

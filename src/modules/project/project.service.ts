import { HttpError } from "../../common/http-error.js";
import type { AuthRepository } from "../auth/auth.repository.js";
import type { ProjectRepository } from "./project.repository.js";
import type { CreateProjectInput } from "./project.types.js";

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly authRepository: AuthRepository
  ) {}

  list(currentUserId: string) {
    return this.repository.list(currentUserId);
  }

  async getByIdOrThrow(projectId: string, currentUserId: string) {
    const project = await this.repository.findByIdForUser(projectId, currentUserId);
    if (!project) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    return project;
  }

  async listMembersOrThrow(projectId: string, currentUserId: string) {
    const exists = await this.repository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    const myRole = await this.repository.findMemberRole(projectId, currentUserId);
    if (!myRole) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    return this.repository.listMembers(projectId);
  }

  create(
    input: CreateProjectInput,
    creator: { id: string; name: string; avatarUrl: string | null }
  ) {
    return this.repository.create(input, creator);
  }

  async inviteMembersByEmails(projectId: string, currentUserId: string, emails: string[]) {
    const exists = await this.repository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    const myRole = await this.repository.findMemberRole(projectId, currentUserId);
    if (myRole !== "OWNER") {
      throw new HttpError(403, "프로젝트 초대 권한이 없습니다.");
    }

    const normalizedEmails = emails.map((email) => email.trim().toLowerCase());
    const users = await Promise.all(
      normalizedEmails.map(async (email) => {
        const user = await this.authRepository.findByEmail(email);
        return { email, user };
      })
    );

    const missingEmails = users.filter((item) => !item.user).map((item) => item.email);
    if (missingEmails.length > 0) {
      throw new HttpError(404, "일부 이메일 사용자를 찾을 수 없습니다.", {
        missingEmails,
      });
    }

    const alreadyMemberEmails: string[] = [];
    for (const item of users) {
      const user = item.user;
      if (!user) {
        continue;
      }
      const invitedUserRole = await this.repository.findMemberRole(projectId, user.id);
      if (invitedUserRole) {
        alreadyMemberEmails.push(item.email);
      }
    }
    if (alreadyMemberEmails.length > 0) {
      throw new HttpError(409, "이미 프로젝트 멤버인 이메일이 포함되어 있습니다.", {
        alreadyMemberEmails,
      });
    }

    const invitedMembers = [];
    for (const item of users) {
      const user = item.user;
      if (!user) {
        continue;
      }
      const member = await this.repository.addMember({
        projectId,
        user: {
          id: user.id,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
        role: "MEMBER",
      });
      invitedMembers.push(member);
    }

    return invitedMembers;
  }

  async deleteOrThrow(projectId: string, currentUserId: string): Promise<void> {
    const exists = await this.repository.existsById(projectId);
    if (!exists) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    const myRole = await this.repository.findMemberRole(projectId, currentUserId);
    if (myRole !== "OWNER") {
      throw new HttpError(403, "프로젝트 삭제 권한이 없습니다.");
    }

    await this.repository.deleteById(projectId);
  }
}

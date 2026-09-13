import { HttpError } from "../../common/http-error.js";
import type { AuthRepository } from "../auth/auth.repository.js";
import type { ProjectRepository } from "./project.repository.js";
import type { CreateProjectInput } from "./project.types.js";

// 팀당 최대 인원. 제품 제약이 아니라 안전장치다 — 초대는 되돌릴 수 없으므로
// 사고가 나도 피해가 여기서 멈추게 한다 (A-2 BR-A2-04).
// 상한이 링크 유출을 "알려주지는" 못한다. 탐지는 별개 문제다.
export const MAX_TEAM_MEMBERS = 20;

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

  // 링크 합류와 이메일 초대가 같이 쓴다.
  // 한쪽에만 걸면 다른 경로로 21명째가 들어온다.
  //
  // ponytail: 세는 것과 넣는 것 사이에 틈이 있어 동시 합류 시 상한을 한두 명 넘을 수 있다.
  // 베타 규모(10개 팀)에서는 수용한다. 엄밀히 하려면 project_members를 잠그는
  // 트랜잭션 안에서 COUNT와 INSERT를 함께 해야 한다.
  private async assertRoomForMembers(projectId: string, adding: number, message: string) {
    const current = await this.repository.countMembers(projectId);
    if (current + adding > MAX_TEAM_MEMBERS) {
      throw new HttpError(409, message);
    }
  }

  async getInviteInfo(code: string, currentUserId: string) {
    const project = await this.repository.findProjectByInviteCode(code);
    if (!project) {
      throw new HttpError(404, "유효하지 않은 초대 링크입니다.");
    }

    const role = await this.repository.findMemberRole(project.id, currentUserId);

    return {
      project: { id: project.id, name: project.name },
      isAlreadyMember: role !== null,
      // 아직 멤버가 아니면 합류했을 때 받게 될 역할을 돌려준다.
      // FE 계약(InviteInfoResponse)이 role을 필수로 요구하는데 비멤버에게는 역할이 없다.
      role: role ?? "MEMBER",
    };
  }

  async joinByInviteCode(code: string, currentUserId: string) {
    const project = await this.repository.findProjectByInviteCode(code);
    if (!project) {
      throw new HttpError(404, "유효하지 않은 초대 링크입니다.");
    }

    // 이미 멤버면 아무것도 하지 않고 성공으로 돌려준다 — 수락을 두 번 눌러도 같은 결과다.
    // 인원 검사보다 앞에 둔다. 팀이 꽉 찬 뒤에 기존 멤버가 링크를 다시 열었을 때
    // 자기 팀에 못 들어가는 일이 생기면 안 된다.
    const existingRole = await this.repository.findMemberRole(project.id, currentUserId);
    if (existingRole) {
      return {
        projectId: project.id,
        role: existingRole,
        message: "이미 참여 중인 프로젝트입니다.",
      };
    }

    await this.assertRoomForMembers(
      project.id,
      1,
      `${project.name} 팀은 인원이 다 찼어요(${MAX_TEAM_MEMBERS}명). 링크를 보내준 분에게 알려주세요.`
    );

    const user = await this.authRepository.findById(currentUserId);
    if (!user) {
      throw new HttpError(404, "사용자를 찾을 수 없습니다.");
    }

    await this.repository.addMember({
      projectId: project.id,
      user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
      role: "MEMBER",
    });

    return {
      projectId: project.id,
      role: "MEMBER" as const,
      message: `${project.name} 프로젝트에 참여했습니다.`,
    };
  }

  // 링크를 새로 만들고 이전 링크를 막는다. 잘못 공유했을 때 되돌리는 유일한 경로다.
  // 권한은 모든 멤버 — 초대 권한이 모든 멤버이므로(2026-09-08 확정) 회수도 같이 간다.
  async reissueInviteOrThrow(projectId: string, currentUserId: string) {
    const myRole = await this.repository.findMemberRole(projectId, currentUserId);
    if (!myRole) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    const code = await this.repository.reissueInvite({ projectId, actorId: currentUserId });
    return { inviteCode: code };
  }

  // 내보내기와 나가기가 같은 라우트를 쓴다. 대상이 본인이면 나가기다.
  async removeMemberOrThrow(projectId: string, targetUserId: string, currentUserId: string) {
    const myRole = await this.repository.findMemberRole(projectId, currentUserId);
    if (!myRole) {
      throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
    }

    const targetRole = await this.repository.findMemberRole(projectId, targetUserId);
    if (!targetRole) {
      throw new HttpError(404, "해당 멤버를 찾을 수 없습니다.");
    }

    // OWNER가 나가면 주인 없는 프로젝트가 된다. 위임 기능이 생기기 전까지는 막는다.
    if (targetRole === "OWNER") {
      throw new HttpError(403, "프로젝트 소유자는 나가거나 제거될 수 없습니다.");
    }

    const isSelf = targetUserId === currentUserId;
    if (!isSelf && myRole !== "OWNER") {
      throw new HttpError(403, "다른 멤버를 제거할 권한이 없습니다.");
    }

    await this.repository.removeMember(projectId, targetUserId);
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

    // 링크 경로와 같은 검사를 태운다. 이메일 UI는 내려가지만 라우트는 베타 동안 남아
    // 직접 호출이 가능하다 (A-2 D-7 1단계).
    await this.assertRoomForMembers(
      projectId,
      users.length,
      `팀이 ${MAX_TEAM_MEMBERS}명으로 꽉 찼어요. 새로 초대하려면 멤버를 내보내 자리를 비워주세요.`
    );

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

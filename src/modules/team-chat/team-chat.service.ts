import { HttpError } from "../../common/http-error.js";
import { ProjectRepository } from "../project/project.repository.js";
import { TeamChatRepository } from "./team-chat.repository.js";
import { TEAM_CHAT_MAX_PARTICIPANTS, TEAM_CHAT_MIN_PARTICIPANTS } from "./team-chat.schema.js";

// 명세 BR-D2-04. 한 프로젝트가 가질 수 있는 팀 채팅방 수다.
export const MAX_TEAM_CHAT_ROOMS = 50;

export type LeaveRoomResult = { deleted: boolean };

export class TeamChatService {
    constructor(
        private readonly repository: TeamChatRepository,
        private readonly projectRepository: ProjectRepository,
    ) {}

    async createRoom(params: {
        projectId: string;
        name: string;
        memberIds: string[];
        currentUserId: string;
    }) {
        const exists = await this.projectRepository.existsById(params.projectId);
        if (!exists) {
            throw new HttpError(404, "프로젝트를 찾을 수 없습니다. ");
        }

        const myRole = await this.projectRepository.findMemberRole(params.projectId, params.currentUserId);
        if (!myRole) {
            throw new HttpError(403, "프로젝트 멤버만 채팅방을 생성할 수 있습니다.");
        }

        // 생성자 본인은 서버가 자동으로 방장으로 넣는다. 중복 요청도 defensive 하게 걸러낸다.
        const others = Array.from(
            new Set(params.memberIds.filter((id) => id !== params.currentUserId))
        );

        if (others.length > 0) {
            const roles = await this.projectRepository.findMemberRoles(params.projectId, others);
            const missing = others.filter((id) => !roles.has(id));
            if (missing.length > 0) {
                throw new HttpError(400, "프로젝트 멤버가 아닌 사용자가 포함되어 있습니다.", {
                    missingUserIds: missing,
                });
            }
        }

        // 방장 1명 포함. 참여자 상·하한을 통과해야 방을 만들 수 있다.
        const total = 1 + others.length;
        if (total < TEAM_CHAT_MIN_PARTICIPANTS || total > TEAM_CHAT_MAX_PARTICIPANTS) {
            throw new HttpError(
                400,
                `팀 채팅은 ${TEAM_CHAT_MIN_PARTICIPANTS}명 이상 ${TEAM_CHAT_MAX_PARTICIPANTS}명 이하만 가능합니다.`
            );
        }

        // 명세 BR-D2-04. 팀 채팅방은 공용이라 프로젝트 단위로 센다.
        //
        // ponytail: 세는 것과 넣는 것 사이에 틈이 있어 동시 생성 시 한도를 한둘 넘을 수 있다.
        // 베타 규모에서 수용한다.
        const current = await this.repository.countRooms(params.projectId);
        if (current >= MAX_TEAM_CHAT_ROOMS) {
            throw new HttpError(409, "채팅방 최대 개수에 도달했습니다. 이전 채팅을 삭제해주세요.");
        }

        const normalized = params.name.trim();
        const duplicated = await this.repository.nameExists(params.projectId, normalized);
        if (duplicated) {
            throw new HttpError(409, "이미 사용 중인 채팅방 이름입니다.");
        }

        return this.repository.createRoomWithParticipants({
            id: crypto.randomUUID(),
            projectId: params.projectId,
            name: normalized,
            createdBy: params.currentUserId,
            memberIds: others,
        });
    }

    async getRoomOrThrow(chatId: string, currentUserId: string){
        const room = await this.repository.getRoom(chatId);

        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRole = await this.projectRepository.findMemberRole(room.projectId, currentUserId);
        if (!myRole) {
            throw new HttpError(403, "접근 권한이 없습니다.");
        }

        return room;
    }

    // BR-D3-02 — 팀 채팅은 방 멤버 누구나 이름을 바꿀 수 있다.
    async renameRoomOrThrow(params: { chatId: string; name: string; currentUserId: string }) {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRole = await this.projectRepository.findMemberRole(room.projectId, params.currentUserId);
        if (!myRole) {
            throw new HttpError(403, "프로젝트 멤버만 채팅방 이름을 변경할 수 있습니다.");
        }

        const normalized = params.name.trim();
        const duplicated = await this.repository.nameExists(room.projectId, normalized, params.chatId);
        if (duplicated) {
            throw new HttpError(409, "이미 사용 중인 채팅방 이름입니다.");
        }

        const updated = await this.repository.renameRoom(params.chatId, normalized);
        if (!updated) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }
        return updated;
    }

    // BR-D1-04 — 하드 삭제다. 되돌릴 수 없어 방 OWNER 로 제한한다.
    async deleteRoomOrThrow(params: { chatId: string; currentUserId: string }) {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        // 프로젝트 역할이 아니라 방 역할이다. 프로젝트 OWNER 라도 남의 방은 못 지운다.
        const myRoomRole = await this.repository.getParticipantRole(params.chatId, params.currentUserId);
        if (myRoomRole !== "OWNER") {
            throw new HttpError(403, "채팅방을 만든 사람만 삭제할 수 있습니다.");
        }

        const deleted = await this.repository.deleteRoom(params.chatId);
        if (!deleted) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }
    }

    async getRoomsByProject(projectId: string, currentUserId: string) {
        const exists = await this.projectRepository.existsById(projectId);
        if (!exists) {
            throw new HttpError(404, "프로젝트를 찾을 수 없습니다.");
        }

        const myRole = await this.projectRepository.findMemberRole(projectId, currentUserId);
        if (!myRole) {
            throw new HttpError(403, "접근 권한이 없습니다.");
        }

        return this.repository.getRoomsByProject(projectId);
    }

    async getMessages(params: {
        chatId: string;
        currentUserId: string;
        limit: number;
        before?: Date;
    }) {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRole = await this.projectRepository.findMemberRole(room.projectId, params.currentUserId);
        if (!myRole) {
            throw new HttpError(403, "접근 권한이 없습니다.");
        }

        return this.repository.getMessage({
            chatId: params.chatId,
            limit: params.limit,
            before: params.before,
        });
    }

    async addParticipant(params: {
        chatId: string;
        userId: string;
        currentUserId: string;
    }) {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        // 명세 D-5 — 프로젝트 OWNER 전용이 아니라 방 참여자 누구나 추가할 수 있다.
        // 기준이 프로젝트가 아니라 방이다. 내가 없는 방에 남을 넣을 수는 없다.
        const myRoomRole = await this.repository.getParticipantRole(params.chatId, params.currentUserId);
        if (!myRoomRole) {
            throw new HttpError(403, "채팅방 참여자만 다른 멤버를 추가할 수 있습니다.");
        }

        // 대상은 프로젝트 멤버여야 한다. 아무나 넣을 수 있게 하면 프로젝트 멤버가 아닌
        // 사람이 팀 채팅에 들어오고, 팀 채팅에는 코드 이야기가 오간다.
        const targetRole = await this.projectRepository.findMemberRole(room.projectId, params.userId);
        if (!targetRole) {
            throw new HttpError(403, "프로젝트 멤버만 초대할 수 있습니다.");
        }

        // 이미 활성 참여자면 두 번 넣지 않는다.
        const targetRoomRole = await this.repository.getParticipantRole(params.chatId, params.userId);
        if (targetRoomRole) {
            throw new HttpError(409, "이미 참여 중인 사용자입니다.");
        }

        // MAX 검사는 이미 있는 사람은 통과시켜야 하므로 위의 재참여 검사 뒤에 둔다.
        const active = await this.repository.countActiveParticipants(params.chatId);
        if (active >= TEAM_CHAT_MAX_PARTICIPANTS) {
            throw new HttpError(
                409,
                `팀 채팅 최대 인원(${TEAM_CHAT_MAX_PARTICIPANTS}명)에 도달했습니다.`
            );
        }

        await this.repository.addParticipant({
            chatId: params.chatId,
            userId: params.userId,
            role: "MEMBER",
        });
    }

    // 강퇴 — 방장이 다른 활성 참여자를 내보낸다.
    async kickParticipant(params: {
        chatId: string;
        targetUserId: string;
        currentUserId: string;
    }): Promise<{ chatDeleted: boolean }> {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        if (params.targetUserId === params.currentUserId) {
            throw new HttpError(400, "자기 자신은 강퇴할 수 없습니다. 나가기를 사용해주세요.");
        }

        const myRoomRole = await this.repository.getParticipantRole(params.chatId, params.currentUserId);
        if (myRoomRole !== "OWNER") {
            throw new HttpError(403, "방장만 다른 참여자를 내보낼 수 있습니다.");
        }

        const targetRole = await this.repository.getParticipantRole(params.chatId, params.targetUserId);
        if (!targetRole) {
            throw new HttpError(400, "채팅방 참여자가 아닙니다.");
        }

        await this.repository.kickParticipant(params.chatId, params.targetUserId);

        // 방장이 자기 자신은 못 내보내지만, 안전장치로 남은 인원이 0이면 방을 지운다.
        const active = await this.repository.countActiveParticipants(params.chatId);
        if (active === 0) {
            await this.repository.deleteRoom(params.chatId);
            return { chatDeleted: true };
        }
        return { chatDeleted: false };
    }

    // 방장 양도 — 새 방장으로 승격하고 원 방장은 방을 나간다.
    async transferOwnership(params: {
        chatId: string;
        newOwnerId: string;
        currentUserId: string;
    }): Promise<{ previousOwnerId: string; newOwnerId: string }> {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        if (params.newOwnerId === params.currentUserId) {
            throw new HttpError(400, "자기 자신에게는 방장을 양도할 수 없습니다.");
        }

        const myRoomRole = await this.repository.getParticipantRole(params.chatId, params.currentUserId);
        if (myRoomRole !== "OWNER") {
            throw new HttpError(403, "방장만 방장을 양도할 수 있습니다.");
        }

        const targetRole = await this.repository.getParticipantRole(params.chatId, params.newOwnerId);
        if (targetRole !== "MEMBER" && targetRole !== "ADMIN") {
            throw new HttpError(400, "양도 대상이 채팅방의 활성 참여자가 아닙니다.");
        }

        await this.repository.transferOwnership({
            chatId: params.chatId,
            oldOwnerId: params.currentUserId,
            newOwnerId: params.newOwnerId,
        });

        return { previousOwnerId: params.currentUserId, newOwnerId: params.newOwnerId };
    }

    // 명세 D-5 — 참여자 나가기. 메시지는 남긴다. 나간 사람의 말이 사라지면
    // 남은 사람들의 대화 맥락이 끊긴다.
    async leaveRoomOrThrow(params: { chatId: string; currentUserId: string }): Promise<LeaveRoomResult> {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRoomRole = await this.repository.getParticipantRole(params.chatId, params.currentUserId);
        if (!myRoomRole) {
            throw new HttpError(403, "채팅방 참여자가 아닙니다.");
        }

        // 방 OWNER 는 나갈 수 없다. 나가면 그 방을 지울 사람이 없어진다(D-1 은 방 OWNER 전용).
        // 방장을 넘기고 싶으면 방장 양도(transferOwnership) 를 쓰라고 안내한다.
        if (myRoomRole === "OWNER") {
            throw new HttpError(403, "방장은 나갈 수 없습니다. 방장을 다른 참여자에게 양도한 뒤 나가주세요.");
        }

        return this.repository.leaveRoomAndMaybeDeleteChat(params.chatId, params.currentUserId);
    }

    async getParticipants(chatId: string, currentUserId: string) {
        const room = await this.repository.getRoom(chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRole = await this.projectRepository.findMemberRole(room.projectId, currentUserId);
        if (!myRole) {
            throw new HttpError(403, "접근 권한이 없습니다.");
        }

        return this.repository.getParticipants(chatId);
    }

    // 프로젝트 강퇴 훅 — 해당 프로젝트의 모든 활성 팀 채팅에서 이 유저를 정리한다.
    // OWNER 였으면 가장 오래된 다른 활성 참여자에게 양도한 뒤 나간다. 잔여자 없으면 방 삭제.
    // 반환값 — route/훅 호출자가 소켓 브로드캐스트에 쓸 수 있는 방 별 결과.
    async onProjectMemberRemoved(
        projectId: string,
        removedUserId: string
    ): Promise<Array<{
        chatId: string;
        wasOwner: boolean;
        successorId: string | null;
        chatDeleted: boolean;
    }>> {
        const rooms = await this.repository.findActiveTeamChatIdsByMember(projectId, removedUserId);
        const results: Array<{
            chatId: string;
            wasOwner: boolean;
            successorId: string | null;
            chatDeleted: boolean;
        }> = [];

        for (const { chatId, memberRole } of rooms) {
            if (memberRole === "OWNER") {
                const successor = await this.repository.findOldestActiveParticipant(chatId, removedUserId);
                if (successor) {
                    await this.repository.transferOwnership({
                        chatId,
                        oldOwnerId: removedUserId,
                        newOwnerId: successor,
                    });
                    // transferOwnership 안에서 원 OWNER 는 이미 leave 처리됐다.
                    results.push({ chatId, wasOwner: true, successorId: successor, chatDeleted: false });
                } else {
                    const { deleted } = await this.repository.leaveRoomAndMaybeDeleteChat(chatId, removedUserId);
                    results.push({ chatId, wasOwner: true, successorId: null, chatDeleted: deleted });
                }
            } else {
                const { deleted } = await this.repository.leaveRoomAndMaybeDeleteChat(chatId, removedUserId);
                results.push({ chatId, wasOwner: false, successorId: null, chatDeleted: deleted });
            }
        }

        return results;
    }
}

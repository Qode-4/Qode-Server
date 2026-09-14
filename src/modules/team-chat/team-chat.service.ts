import { HttpError } from "../../common/http-error.js";
import { resolveUniqueChatName } from "../chat/unique-name.js";
import { ProjectRepository } from "../project/project.repository.js";
import { TeamChatRepository } from "./team-chat.repository.js";

// 명세 BR-D2-04. 한 프로젝트가 가질 수 있는 팀 채팅방 수다.
export const MAX_TEAM_CHAT_ROOMS = 50;

export class TeamChatService {
    constructor(
        private readonly repository: TeamChatRepository,
        private readonly projectRepository: ProjectRepository,
    ) {}

    async createRoom(params: {
        projectId: string;
        name: string;
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

        // 명세 BR-D2-04. 팀 채팅방은 공용이라 프로젝트 단위로 센다.
        //
        // ponytail: 세는 것과 넣는 것 사이에 틈이 있어 동시 생성 시 한도를 한둘 넘을 수 있다.
        // 베타 규모에서 수용한다.
        const current = await this.repository.countRooms(params.projectId);
        if (current >= MAX_TEAM_CHAT_ROOMS) {
            throw new HttpError(409, "채팅방 최대 개수에 도달했습니다. 이전 채팅을 삭제해주세요.");
        }

        return this.repository.createRoom({
            id: crypto.randomUUID(),
            projectId: params.projectId,
            name: params.name,
            createdBy: params.currentUserId,
        });
    }

    // 명세 BR-D5-01 — 읽기 권한은 "프로젝트 멤버"가 아니라 "방 참여자"다.
    // 프로젝트 멤버 기준이면 초대받지 않은 방의 대화까지 다 읽힌다.
    //
    // 방을 만든 사람은 createRoom 이 OWNER 참여자로 넣어주므로 자기 방에서 막히지 않는다.
    // 나간 사람은 left_at 이 찍혀 getParticipantRole 이 null 을 준다 — 나가면 안 보인다.
    private async assertRoomParticipant(chatId: string, currentUserId: string) {
        const room = await this.repository.getRoom(chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRoomRole = await this.repository.getParticipantRole(chatId, currentUserId);
        if (!myRoomRole) {
            throw new HttpError(403, "접근 권한이 없습니다.");
        }

        return room;
    }

    async getRoomOrThrow(chatId: string, currentUserId: string){
        return this.assertRoomParticipant(chatId, currentUserId);
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

        // BR-D3-04. 최종 이름을 사용자에게 돌려준다 — "(N)"이 붙었는지 화면이 알아야 한다.
        const taken = await this.repository.listRoomNames(room.projectId, params.chatId);
        const finalName = resolveUniqueChatName(params.name, taken);

        const updated = await this.repository.renameRoom(params.chatId, finalName);
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
        await this.assertRoomParticipant(params.chatId, params.currentUserId);

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

        return this.repository.addParticipant({
            chatId: params.chatId,
            userId: params.userId,
            role: "MEMBER",
        });
    }

    // 명세 D-5 — 참여자 나가기. 메시지는 남긴다. 나간 사람의 말이 사라지면
    // 남은 사람들의 대화 맥락이 끊긴다.
    async leaveRoomOrThrow(params: { chatId: string; currentUserId: string }) {
        const room = await this.repository.getRoom(params.chatId);
        if (!room) {
            throw new HttpError(404, "채팅방을 찾을 수 없습니다.");
        }

        const myRoomRole = await this.repository.getParticipantRole(params.chatId, params.currentUserId);
        if (!myRoomRole) {
            throw new HttpError(403, "채팅방 참여자가 아닙니다.");
        }

        // 방 OWNER 는 나갈 수 없다. 나가면 그 방을 지울 사람이 없어진다(D-1 은 방 OWNER 전용).
        // 초대 링크의 멤버 제거에서 프로젝트 OWNER 를 막은 것과 같은 규칙이다.
        if (myRoomRole === "OWNER") {
            throw new HttpError(403, "채팅방을 만든 사람은 나갈 수 없습니다. 채팅방을 삭제해주세요.");
        }

        const left = await this.repository.leaveRoom(params.chatId, params.currentUserId);
        if (!left) {
            throw new HttpError(404, "채팅방 참여자가 아닙니다.");
        }
    }

    async getParticipants(chatId: string, currentUserId: string) {
        await this.assertRoomParticipant(chatId, currentUserId);

        return this.repository.getParticipants(chatId);
    }
}
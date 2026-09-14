import { HttpError } from "../../common/http-error.js";
import { resolveUniqueChatName } from "../chat/unique-name.js";
import { ProjectRepository } from "../project/project.repository.js";
import { TeamChatRepository } from "./team-chat.repository.js";

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

        return this.repository.createRoom({
            id: crypto.randomUUID(),
            projectId: params.projectId,
            name: params.name,
            createdBy: params.currentUserId,
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
}
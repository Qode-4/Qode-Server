import { HttpError } from "../../common/http-error.js";
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

        const myRole = await this.projectRepository.findMemberRole(room.projectId, params.currentUserId);
        if (myRole !== "OWNER") {
            throw new HttpError(403, "채팅방 참여자 추가 권한이 없습니다.");
        }

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
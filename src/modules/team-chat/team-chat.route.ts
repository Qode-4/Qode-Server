
import { TeamChatRepository } from "./team-chat.repository.js";
import { ProjectRepository } from "../project/project.repository.js";
import { AuthRepository } from "../auth/auth.repository.js";
import { FastifyInstance } from "fastify";
import type { Server as SocketIoServer } from "socket.io";
import { AuthService } from "../auth/auth.service.js";
import { TeamChatService } from "./team-chat.service.js";
import { HttpError } from "../../common/http-error.js";
import {
    chatIdParamSchema,
    projectIdParamSchema,
    createRoomBodySchema,
    getMessagesQuerySchema,
    addParticipantBodySchema,
    renameRoomBodySchema,
    projectChatParamSchema,
    chatUserParamSchema,
    transferOwnershipBodySchema,
} from "../team-chat/team-chat.schema.js";

type RouteDeps = {
    repository: TeamChatRepository;
    projectRepository: ProjectRepository;
    authRepository: AuthRepository;
    service?: TeamChatService;
    io?: SocketIoServer | null;
};

export const registerTeamChatRoutes = async (
    app: FastifyInstance,
    deps: RouteDeps
) => {
    const authService = new AuthService(deps.authRepository);
    const service = deps.service ?? new TeamChatService(deps.repository, deps.projectRepository);
    const io = deps.io ?? null;

    // 소켓이 준비 안 됐으면 조용히 건너뛴다. Kafka 미준비 시나리오와 같은 graceful 처리다.
    const emit = (chatId: string, event: string, payload: unknown) => {
        if (!io) return;
        io.to(chatId).emit(event, payload);
    };

    const authHeaderSchema = {
        type: "object",
        properties: {
            authorization: { type: "string" },
        },
        required: ["authorization"],
    } as const;

    const roomSchema = {
        type: "object",
        properties: {
             id: { type: "string", format: "uuid" },
             projectId: { type: "string", format: "uuid" },
             name: { type: "string" },
             createdBy: { type: "string", format: "uuid" },
             createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "projectId", "name", "createdBy", "createdAt"],
    } as const;

    const messageSchema = {
        type: "object",
        properties: {
            id: { type: "string", fromat: "uuid" },
            chatId: { type: "string", format: "uuid" },
            userId: { type: "string", format: "uuid" },
            userName: { type: "string" },
            avatarUrl: { anyOf: [{type: "string"}, { type: "null" }] },
            content: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "chatId", "userId", "userName", "avatarUrl", "content", "createdAt"],
    } as const;

    const participantSchema = {
        type: "object",
        properties: {
            chatId: { type: "string", format: "uuid" },
            userId: { type: "string", format: "uuid" },
            memberRole: { type: "string", enum: ["OWNER", "ADMIN", "MEMBER"] },
            joinedAt: { type: "string", format: "date-time" },
            userName: { type: "string" },
            avatarUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["chatId", "userId", "memberRole", "joinedAt", "userName", "avatarUrl"],
    } as const;

    const errorSchema = {
        type: "object",
        properties: {
            status: { type: "integer" },
            ok: { type: "boolean" },
            error: { type: "string" },
            message: { type: "string" },
            details: {},
        },
        required: ["status", "ok", "error", "message"],
    } as const;

    const getAccessToken = (authorization?: string): string => {
        if (!authorization || !authorization.startsWith("Bearer ")) {
            throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
        }

        const token = authorization.slice("Bearer ".length).trim();
        if (!token) {
            throw new HttpError(401, "인증이 만료되었습니다. 다시 로그인해 주세요.");
        }

        return token;
    };


    // 채팅방 생성
    app.post(
        "/api/projects/:projectId/chats",
        {
            schema: {
                tags: ["team-chat"],
                summary: "Create team in chat room",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: {
                        projectId: { type: "string", format: "uuid" },
                    },
                    required: ["projectId"],
                },
                body: {
                    type: "object",
                    properties: {
                        name: { type: "string", minLength: 1, maxLength: 100 },
                        memberIds: {
                            type: "array",
                            items: { type: "string", format: "uuid" },
                            minItems: 1,
                            maxItems: 19,
                        },
                    },
                    required: ["name", "memberIds"],
                },
                response: {
                    201: {
                        type: "object",
                        properties: {
                            ok: { type: "boolean" },
                            data: roomSchema,
                        },
                        required: ["ok", "data"],
                    },
                    409: errorSchema,
                },
            }
        },
        async (request, reply) => {
            const { projectId } = projectIdParamSchema.parse(request.params);
            const { name, memberIds } = createRoomBodySchema.parse(request.body);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);
            const data = await service.createRoom({
                projectId,
                name,
                memberIds,
                currentUserId: me.id,
            });
            return reply.status(201).send({ ok: true, data });
        }
    );

    app.get(
        "/api/projects/:projectId/chats",
        {
            schema: {
                tags: ["team-chat"],
                summary: "List team chat rooms by project",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: {
                        projectId: { type: "string", format: "uuid" },
                    },
                    required: ["projectId"],
                },
                response: {
                    200: {
                        type: "object",
                        properties: {
                            ok: { type: "boolean" },
                            data: { type: "array", items: roomSchema },
                        },
                        required: ["ok", "data"],
                    },
                },
            },
        },
        async (request, reply) => {
            const { projectId } = projectIdParamSchema.parse(request.params);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);
            const data = await service.getRoomsByProject(projectId, me.id);
            return reply.send({ ok: true, data });
        }
    );

    // 채팅방 단건 조회
    app.get(
        "/api/chats/:chatId",
        {
            schema: {
                tags: ["team-chat"],
                summary: "Get chat room by id",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: {
                        chatId: { type: "string", format: "uuid" },
                    },
                    required: ["chatId"],
                },
                response: {
                    200: {
                        type: "object",
                        properties: {
                            ok: { type: "boolean" },
                            data: roomSchema,
                        },
                        required: ["ok", "data"],
                    },
                },
            },
        },
        async (request, reply) => {
            const { chatId } = chatIdParamSchema.parse(request.params);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);
            const data = await service.getRoomOrThrow(chatId, me.id);
            return reply.send({ ok: true, data });
        }
    );

    // 메시지 목록
    app.get(
        "/api/chats/:chatId/messages",
        {
            schema: {
                tags: ["team-chat"],
                summary: "Get messages in chat room",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: {
                        chatId: { type: "string", format: "uuid" },
                    },
                    required: ["chatId"],
                },
                querystring: {
                    type: "object",
                    properties: {
                        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
                        before: { type: "string", format: "date-time" },
                    },
                },
                response: {
                    200: {
                        type: "object",
                        properties: {
                            ok: { type: "boolean" },
                            data: { type: "array", items: messageSchema },
                        },
                        required: ["ok", "data"],
                    },
                },
            },
        },
        async (request, reply) => {
            const { chatId } = chatIdParamSchema.parse(request.params);
            const query = getMessagesQuerySchema.parse(request.query);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);
            const data = await service.getMessages({
                chatId,
                currentUserId: me.id,
                limit: query.limit,
                before: query.before ? new Date(query.before) : undefined,
            });
            return reply.send({ ok: true, data });
        }
    );

    // 참여자 목록
    app.get(
        "/api/chats/:chatId/participants",
        {
            schema: {
                tags: ["team-chat"],
                summary: "Get participants in chat room",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: {
                        chatId: { type: "string", format: "uuid" },
                    },
                    required: ["chatId"],
                },
                response: {
                    200: {
                        type: "object",
                        properties: {
                            ok: { type: "boolean" },
                            data: { type: "array", items: participantSchema },
                        },
                        required: ["ok", "data"],
                    },
                },
            },
        },
        async (request, reply) => {
            const { chatId } = chatIdParamSchema.parse(request.params);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);
            const data = await service.getParticipants(chatId, me.id);
            return reply.send({ ok: true, data });
        }
    );

    // 참여자 추가
    // 명세 D-3 — 팀 채팅방 이름 변경. 방 멤버 누구나 바꿀 수 있다. 중복은 409.
    app.patch(
        "/api/projects/:projectId/chats/:chatId",
        {
            schema: {
                tags: ["team-chat"],
                summary: "Rename team chat room",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: {
                        projectId: { type: "string", format: "uuid" },
                        chatId: { type: "string", format: "uuid" },
                    },
                    required: ["projectId", "chatId"],
                },
                body: {
                    type: "object",
                    properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
                    required: ["name"],
                },
                response: {
                    200: {
                        type: "object",
                        properties: {
                            ok: { type: "boolean" },
                            data: roomSchema,
                        },
                        required: ["ok", "data"],
                    },
                    409: errorSchema,
                },
            },
        },
        async (request, reply) => {
            const params = projectChatParamSchema.parse(request.params);
            const body = renameRoomBodySchema.parse(request.body);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);

            const data = await service.renameRoomOrThrow({
                chatId: params.chatId,
                name: body.name,
                currentUserId: me.id,
            });
            emit(params.chatId, "team:room:renamed", { chatId: params.chatId, name: data.name });
            return reply.send({ ok: true, data });
        }
    );

    // 명세 D-1 — 팀 채팅방 삭제. 하드 삭제라 방 OWNER 로 제한한다(BR-D1-04).
    app.delete(
        "/api/projects/:projectId/chats/:chatId",
        {
            schema: {
                tags: ["team-chat"],
                summary: "Delete team chat room",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: {
                        projectId: { type: "string", format: "uuid" },
                        chatId: { type: "string", format: "uuid" },
                    },
                    required: ["projectId", "chatId"],
                },
            },
        },
        async (request, reply) => {
            const params = projectChatParamSchema.parse(request.params);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);

            await service.deleteRoomOrThrow({ chatId: params.chatId, currentUserId: me.id });
            emit(params.chatId, "team:room:deleted", { chatId: params.chatId });
            return reply.send({ ok: true });
        }
    );

    // 명세 D-5 — 참여자 나가기. 메시지는 남는다.
    // 마지막 참여자가 나가면 방이 자동 삭제된다.
    app.delete(
        "/api/chats/:chatId/participants/me",
        {
            schema: {
                tags: ["team-chat"],
                summary: "Leave team chat room",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: { chatId: { type: "string", format: "uuid" } },
                    required: ["chatId"],
                },
                response: {
                    200: {
                        type: "object",
                        properties: {
                            ok: { type: "boolean" },
                            data: {
                                type: "object",
                                properties: { chatDeleted: { type: "boolean" } },
                                required: ["chatDeleted"],
                            },
                        },
                        required: ["ok", "data"],
                    },
                },
            },
        },
        async (request, reply) => {
            const { chatId } = chatIdParamSchema.parse(request.params);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);

            const { deleted } = await service.leaveRoomOrThrow({ chatId, currentUserId: me.id });
            emit(chatId, "team:participants:changed", { chatId });
            if (deleted) {
                emit(chatId, "team:room:deleted", { chatId });
            }
            return reply.send({ ok: true, data: { chatDeleted: deleted } });
        }
    );

    app.post(
        "/api/chats/:chatId/participants",
        {
            schema: {
                tags: ["team-chat"],
                summary: "Add participant to chat room",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: {
                        chatId: { type: "string", format: "uuid" },
                    },
                    required: ["chatId"],
                },
                body: {
                    type: "object",
                    properties: {
                        userId: { type: "string", format: "uuid" },
                    },
                    required: ["userId"],
                },
                response: {
                    204: { type: "null" },
                    409: errorSchema,
                },
            },
        },
        async (request, reply) => {
            const { chatId } = chatIdParamSchema.parse(request.params);
            const { userId } = addParticipantBodySchema.parse(request.body);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);
            await service.addParticipant({ chatId, userId, currentUserId: me.id });
            emit(chatId, "team:participants:changed", { chatId });
            return reply.status(204).send();
        }
    );

    // 강퇴. 방장이 다른 참여자를 내보낸다. 방장 자신은 강퇴할 수 없다.
    app.delete(
        "/api/chats/:chatId/participants/:userId",
        {
            schema: {
                tags: ["team-chat"],
                summary: "Kick participant from chat room",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: {
                        chatId: { type: "string", format: "uuid" },
                        userId: { type: "string", format: "uuid" },
                    },
                    required: ["chatId", "userId"],
                },
                response: {
                    204: { type: "null" },
                    400: errorSchema,
                    403: errorSchema,
                },
            },
        },
        async (request, reply) => {
            const { chatId, userId } = chatUserParamSchema.parse(request.params);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);
            const { chatDeleted } = await service.kickParticipant({
                chatId,
                targetUserId: userId,
                currentUserId: me.id,
            });
            emit(chatId, "team:participants:changed", { chatId });
            if (chatDeleted) {
                emit(chatId, "team:room:deleted", { chatId });
            }
            return reply.status(204).send();
        }
    );

    // 방장 양도. 새 방장 승격 + 원 방장 leave 를 한 트랜잭션에서 처리한다.
    app.post(
        "/api/chats/:chatId/transfer-ownership",
        {
            schema: {
                tags: ["team-chat"],
                summary: "Transfer chat room ownership",
                headers: authHeaderSchema,
                params: {
                    type: "object",
                    properties: {
                        chatId: { type: "string", format: "uuid" },
                    },
                    required: ["chatId"],
                },
                body: {
                    type: "object",
                    properties: {
                        newOwnerId: { type: "string", format: "uuid" },
                    },
                    required: ["newOwnerId"],
                },
                response: {
                    204: { type: "null" },
                    400: errorSchema,
                    403: errorSchema,
                },
            },
        },
        async (request, reply) => {
            const { chatId } = chatIdParamSchema.parse(request.params);
            const { newOwnerId } = transferOwnershipBodySchema.parse(request.body);
            const token = getAccessToken(request.headers.authorization);
            const me = await authService.getMe(token);
            const { previousOwnerId } = await service.transferOwnership({
                chatId,
                newOwnerId,
                currentUserId: me.id,
            });
            emit(chatId, "team:ownership:transferred", {
                chatId,
                newOwnerId,
                previousOwnerId,
            });
            emit(chatId, "team:participants:changed", { chatId });
            return reply.status(204).send();
        }
    );
};

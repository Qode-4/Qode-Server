// src/lib/kafka/kafka.client.ts
import { Kafka } from "kafkajs";

export const kafka = new Kafka({
    clientId: "qode-server",
    brokers: ["localhost:9092"],
});

export const producer = kafka.producer();
export const consumer = kafka.consumer({ groupId: "team-chat-group" });

export const TOPICS = {
    TEAM_CHAT_MESSAGE: "team-chat-message",
} as const;
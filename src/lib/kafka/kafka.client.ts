// src/lib/kafka/kafka.client.ts
import { Kafka } from "kafkajs";
import { env } from "../../config/env.js";

export const kafka = new Kafka({
    clientId: "qode-server",
    brokers: env.KAFKA_BROKERS.split(",").map((b) => b.trim()).filter(Boolean),
});

export const producer = kafka.producer();
export const consumer = kafka.consumer({ groupId: "team-chat-group" });

export const TOPICS = {
    TEAM_CHAT_MESSAGE: "team-chat-message",
} as const;

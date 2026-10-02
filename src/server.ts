import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({ status: "ok" }));

const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });

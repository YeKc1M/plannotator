/**
 * External annotations (Pi/Node): PATCH ingest of `inReplyTo`.
 *
 * Node mirror of the PATCH describe in packages/server/external-annotations.test.ts:
 * PATCH merges arbitrary fields, so it was the one way to create an inReplyTo
 * self-reference or cycle; the invalid state is refused at ingest on both
 * runtimes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createExternalAnnotationHandler } from "./external-annotations.ts";
import { requestUrl } from "./helpers.ts";

describe("pi external annotations: PATCH inReplyTo", () => {
	const handler = createExternalAnnotationHandler("plan");
	let server: Server;
	let base = "";

	beforeAll(async () => {
		server = createServer(async (req, res) => {
			const handled = await handler.handle(req, res, requestUrl(req));
			if (!handled) {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		base = `http://127.0.0.1:${address.port}`;
	});

	afterAll(() => {
		server.close();
	});

	const patch = async (id: string, body: unknown) => {
		const res = await fetch(`${base}/api/external-annotations?id=${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as { error?: string; annotation?: { inReplyTo?: string } } };
	};

	test("refuses an inReplyTo that is self, missing, or would close a cycle; accepts a valid reply", async () => {
		const added = handler.addAnnotations({
			annotations: [
				{ source: "tool", text: "first" },
				{ source: "tool", text: "second" },
			],
		});
		if ("error" in added) throw new Error(added.error);
		const [first, second] = added.ids;

		expect((await patch(first, { inReplyTo: first })).status).toBe(400);
		expect((await patch(first, { inReplyTo: "nope" })).status).toBe(400);
		expect((await patch(first, { inReplyTo: 7 })).status).toBe(400);

		const ok = await patch(second, { inReplyTo: first });
		expect(ok.status).toBe(200);
		expect(ok.body.annotation?.inReplyTo).toBe(first);

		const cycle = await patch(first, { inReplyTo: second });
		expect(cycle.status).toBe(400);
		expect(cycle.body.error).toContain("cycle");

		expect((await patch(second, { inReplyTo: null })).status).toBe(200);
		expect((await patch(second, { text: "still fine" })).status).toBe(200);
	});
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClientSession, shouldEmitSnapshot } from "../../server/agent-service.js";

/**
 * 切换会话快照去重：switchSession / switchConversation 尾部已经同步发过一份权威
 * 全量快照，bindSession 里的 scheduleSnapshot（60ms 定时器）会在 <100ms 后再补发
 * 一份内容完全相同的快照 —— 每次切换白多序列化一遍整段对话（切换慢的主因之一）。
 * 这里锁住抑制窗口的语义：窗口内只放行 force 快照。
 */

type Emitted = Record<string, unknown>;

interface FakeSnapshotSession {
	disposed: boolean;
	suppressSnapshotUntil: number;
	convs: Map<string, unknown>;
	activeId: string;
	emittedMessages: unknown[] | null;
	emittedConvId: string | null;
	emittedRev: number;
	snapRev: number;
	emitted: Emitted[];
	emitQuestionQueue(): void;
	currentMessages(): unknown[];
	buildLightState(rev: number, withDraft: boolean): Record<string, unknown>;
	emit(msg: Emitted): void;
	newChat(): Promise<boolean>;
	flushSnapshot(forceFull?: boolean): void;
}

/** emitSnapshotNow 只碰这几个成员，其余按鸭子类型补齐即可（无需真 runtime）。 */
function fakeSession(overrides: Partial<FakeSnapshotSession> = {}): FakeSnapshotSession {
	const emitted: Emitted[] = [];
	const self: FakeSnapshotSession = {
		disposed: false,
		suppressSnapshotUntil: 0,
		convs: new Map<string, unknown>([["c1", {}]]),
		activeId: "c1",
		emittedMessages: null,
		emittedConvId: null,
		emittedRev: 0,
		snapRev: 0,
		emitted,
		emitQuestionQueue: () => {},
		currentMessages: () => [],
		buildLightState: (rev: number) => ({ rev }),
		emit: (msg: Emitted) => {
			emitted.push(msg);
		},
		newChat: () => Promise.resolve(true),
		flushSnapshot: () => {},
		...overrides,
	};
	return self;
}

const emitSnapshotNow = (
	ClientSession.prototype as unknown as Record<string, (this: FakeSnapshotSession, forceFull?: boolean) => void>
)["emitSnapshotNow"];

describe("shouldEmitSnapshot：切换抑制窗口判定", () => {
	it("窗口内非 force 快照不放行", () => {
		expect(shouldEmitSnapshot(1_000, 1_250, false)).toBe(false);
	});

	it("窗口内 force 快照永远放行（切换尾部那份 / get_state 重同步）", () => {
		expect(shouldEmitSnapshot(1_000, 1_250, true)).toBe(true);
	});

	it("窗口到期边界与到期后放行", () => {
		expect(shouldEmitSnapshot(1_250, 1_250, false)).toBe(true);
		expect(shouldEmitSnapshot(1_500, 1_250, false)).toBe(true);
	});

	it("从未开窗（until=0，非切换时刻）不抑制", () => {
		expect(shouldEmitSnapshot(1_000, 0, false)).toBe(true);
	});
});

describe("emitSnapshotNow：窗口内只发 force 快照", () => {
	it("窗口内的非 force 快照（bindSession 的 60ms 补发）被静默丢弃", () => {
		const ctx = fakeSession({ suppressSnapshotUntil: Date.now() + 250 });
		emitSnapshotNow.call(ctx, false);
		expect(ctx.emitted).toHaveLength(0);
		// 丢弃必须是「什么都没发生」：revision 不推进，emitted 基准不动
		expect(ctx.snapRev).toBe(0);
		expect(ctx.emittedMessages).toBeNull();
	});

	it("窗口内的 force 快照照发（尾部那份权威全量快照）", () => {
		const ctx = fakeSession({ suppressSnapshotUntil: Date.now() + 250 });
		emitSnapshotNow.call(ctx, true);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0].type).toBe("snapshot");
		expect(ctx.snapRev).toBe(1);
	});

	it("窗口到期后非 force 快照恢复正常", () => {
		const ctx = fakeSession({ suppressSnapshotUntil: Date.now() - 1 });
		emitSnapshotNow.call(ctx, false);
		expect(ctx.emitted).toHaveLength(1);
		expect(ctx.emitted[0].type).toBe("snapshot");
	});

	it("disposed 仍优先于一切（抑制窗口不影响原有短路）", () => {
		const ctx = fakeSession({ disposed: true, suppressSnapshotUntil: 0 });
		emitSnapshotNow.call(ctx, true);
		expect(ctx.emitted).toHaveLength(0);
	});
});

describe("switchSession / switchConversation 的接线", () => {
	const src = readFileSync(join(__dirname, "../../server/agent-service.ts"), "utf-8");

	it("切换尾部开抑制窗口并强制发权威快照（force）", () => {
		expect(src).toContain("this.suppressSnapshotUntil = Date.now() + SWITCH_SNAPSHOT_SUPPRESS_MS;");
		expect(src).toContain("this.flushSnapshot(true);");
		// switchSession 与 switchConversation 各一处
		expect(src.split("this.suppressSnapshotUntil = Date.now() + SWITCH_SNAPSHOT_SUPPRESS_MS;")).toHaveLength(3);
	});

	it("emitSnapshotNow 是唯一被抑制的入口（delta 流式路径不受影响）", () => {
		expect(src).toContain("if (!shouldEmitSnapshot(Date.now(), this.suppressSnapshotUntil, forceFull)) return;");
		// 抑制判定只出现一次：不给 message_delta / snapshot_delta 加任何门
		expect(src.split("shouldEmitSnapshot(Date.now()").length - 1).toBe(1);
	});

	it("切换后的模型栏回填不被抑制窗口吞掉", () => {
		expect(src.split("this.suppressSnapshotUntil = 0;")).toHaveLength(3);
	});
});

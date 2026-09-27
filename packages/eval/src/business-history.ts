/** Frozen pressure history contains no reference fix or hidden acceptance checks. */
export function seedBusinessHistory(directory: string, sessionId: string) {
  const messages: any[] = []
  const created = 1_700_000_000_000
  for (let turn = 0; turn < 14; turn++) {
    const user = `msg_${String(turn * 2).padStart(12, "0")}`
    const assistant = `msg_${String(turn * 2 + 1).padStart(12, "0")}`
    const requirement = turn === 0
      ? "任务约束：T3 仅已支付订单可退款；累计退款数量与金额不得超过已购买数量和实付金额；同一请求重试只能产生一笔退款。"
      : `检查阶段 ${turn}：保留最初的累计退款、状态与幂等约束。`
    messages.push({ info: { id: user, sessionID: sessionId, role: "user", time: { created: created + turn * 100 }, agent: "build", model: { providerID: "bluecode-free", modelID: "mimo-v2.5-free" } },
      parts: [{ id: `prt_${user}`, sessionID: sessionId, messageID: user, type: "text", text: requirement }] })
    const evidence = Array.from({ length: 88 }, (_, line) => `ok ${line + 1} - archived test ${turn}: preserve paid status, cumulative refund and retry identity.`).join("\n")
    messages.push({ info: { id: assistant, sessionID: sessionId, role: "assistant", time: { created: created + turn * 100 + 1, completed: created + turn * 100 + 2 },
      parentID: user, modelID: "mimo-v2.5-free", providerID: "bluecode-free", mode: "build", agent: "build", path: { cwd: directory, root: directory }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" },
      parts: [{ id: `prt_${assistant}`, messageID: assistant, sessionID: sessionId, type: "tool", tool: "bash", callID: `call_${turn}`,
        state: { status: "completed", input: { command: "bun test", description: "Review recorded test output" }, output: evidence, title: "Recorded test output", metadata: { fixture: true },
          time: { start: created + turn * 100 + 1, end: created + turn * 100 + 2 } } }] })
  }
  return { info: { id: sessionId, slug: "T3-pressure", projectID: "global", directory, title: "Business pressure history", version: "1.18.23", time: { created, updated: created + 2000 } }, messages }
}

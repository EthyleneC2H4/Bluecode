import { expect, test } from "bun:test"
import { liveTasks, seedSession } from "../src/live-tasks"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("all twelve live tasks have executable failing baselines and stable complete seed turns", async () => {
  const tasks=liveTasks()
  expect(tasks.length).toBe(12)
  expect(new Set(tasks.map(t=>t.category)).size).toBe(4)
  for(const task of tasks) {
    const dir=await mkdtemp(join(tmpdir(),"headroom-live-task-"))
    try {
      await mkdir(join(dir,"src")); await writeFile(join(dir,"package.json"),'{"type":"module"}')
      for(const [path,text] of Object.entries(task.files)) await writeFile(join(dir,path),text)
      const test=task.category==="test-repair" ? task.files["test.mjs"]! : `import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; import * as m from './src/main.js'; ${task.checks}`
      await writeFile(join(dir,"check.mjs"),test)
      const child=Bun.spawn(["bun","check.mjs"],{cwd:dir,stdout:"ignore",stderr:"ignore"})
      expect(await child.exited).not.toBe(0)
      const seed=seedSession(task,dir,"ses_fixture","mimo-v2.5-free")
      expect(seed.messages.length).toBe(28)
      expect(seed.messages[0].parts[0].text).toContain(task.fact)
      expect(new Set(seed.messages.map(m=>m.info.id)).size).toBe(28)
    } finally { await rm(dir,{recursive:true,force:true}) }
  }
})

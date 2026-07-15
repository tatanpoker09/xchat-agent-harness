import { spawn } from 'bun';

export class SubAgent {
  private child: ReturnType<typeof spawn> | null = null;

  async start(task: string) {
    // Minimal stub — real version will use limited tool set + separate process
    console.log(`[SubAgent] Starting for task: ${task}`);
    this.child = spawn(['bun', 'run', 'src/index.ts', '--subagent', task], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    return this.child;
  }

  async stop() {
    if (this.child) this.child.kill();
  }
}

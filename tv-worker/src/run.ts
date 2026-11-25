import { spawn } from 'node:child_process';

/** Run a command, resolve with stdout; reject with the end of stderr. Never through a shell. */
export function run(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
		p.on('error', (e) => reject(new Error(`${cmd} could not start: ${e.message}`)));
		p.on('close', (code) =>
			code === 0
				? resolve(out)
				: reject(
						new Error(`${cmd} failed (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`)
					)
		);
	});
}

/**
 * init prompts — interactive terminal prompts for `wl init`.
 *
 * Single responsibility: ask the operator a single yes/no question on stdin
 * and resolve their answer.
 */

import * as readline from 'readline';

export async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      const t = String(answer || '').trim().toLowerCase();
      resolve(t === 'y' || t === 'yes');
    });
  });
}

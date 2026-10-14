// src/git.ts (новый файл — вспомогательные функции)

import { execFile } from 'child_process';
import { promisify } from 'util';


const execFileAsync = promisify(execFile);

/**
 * Проверяет, есть ли незакоммиченные изменения в указанном файле.
 * Возвращает:
 *   - 'modified'  — файл изменён (есть в git и был изменён)
 *   - 'untracked' — файл новый, ещё не в git
 *   - 'clean'     — изменений нет
 */
export async function getFileStatus(
    repoRoot: string,
    relPath: string
): Promise<'modified' | 'untracked' | 'clean'> {
    // --porcelain — машиночитаемый формат (стабильный, в отличие от обычного git status)
    const { stdout } = await execFileAsync(
        'git',
        ['status', '--porcelain', '--', relPath],
        { cwd: repoRoot }
    );

    const line = stdout.trim();
    if (!line) {
        return 'clean';
    }
    // Первые два символа в porcelain — код статуса.
    // "??" — untracked, " M" — modified, "M " — staged, "MM" — staged + modified
    if (line.startsWith('??')) {
        return 'untracked';
    }
    return 'modified';
}
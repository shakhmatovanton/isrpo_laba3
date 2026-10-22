# Техническая документация плагина Quick Commit

## 1. Архитектура VS Code и как работает плагин

**Как плагин запускается:**
1. При старте VS Code читает файл `package.json` плагина.
2. Он видит там команды (в разделе `contributes.commands`).
3. Плагин **не активируется сразу**. VS Code ждёт, пока пользователь вызовет команду (это называется *lazy activation*).
4. Когда пользователь нажимает `Ctrl+Shift+P` → `Quick Commit`, VS Code загружает код плагина и вызывает функцию `activate()`.

**`context.subscriptions`**
Когда VS Code вызывает `activate(context)`, он передаёт объект `context`. У него есть массив `subscriptions`. VS Code **автоматически очистит** содержимое, когда плагин выключится. Это необходимо, чтобы не произошла утечка памяти.

---

## 2. Модуль `src/git.ts` (Работа с Git)

Запускает Git-команды и возвращает результат.

```typescript
export async function runGit(args: string[], cwd: string)
```

**Что делает:** Запускает команду Git как дочерний процесс и возвращает результат.

**Параметры:**
- `args` — массив аргументов.
- `cwd` — папка, в которой нужно выполнить команду (Current Working Directory).

**Как работает внутри:**
- Использует `execFileAsync` (обёртка над `child_process.execFile`).
- В опциях передаёт `env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }`. Если Git захочет запросить пароль, он не зависнет в фоновом режиме, а сразу завершится с ошибкой.
- Оборачивает вызов в `try/catch`. Если Git выдал ошибку, он возвращает `{ ok: false, error: ... }`.

**Пример вызова:**
```typescript
const res = await runGit(['status', '--porcelain'], '/home/user/project');
if (res.ok) console.log(res.stdout);
```

### `getFileStatus(repoRoot, relPath)`

```typescript
export async function getFileStatus(repoRoot: string, relPath: string): Promise<'modified' | 'untracked' | 'clean'>
```

**Что делает:** Проверяет, есть ли изменения в конкретном файле.

**Как работает:**
- Вызывает `git status --porcelain -- <путь>`.
- Флаг `--porcelain` заставляет Git выдать ответ в строгом, машиночитаемом формате.
- Если вывод пустой — файл не менялся (`clean`).
- Если начинается с `??` — файл новый, Git его ещё не отслеживает (`untracked`).
- Иначе — файл изменён (`modified`).

**Зачем нужно:** Чтобы не давать пользователю делать пустой коммит.

### `getFileDiff(repoRoot, relPath)`
*   **Что делает:** Возвращает текстовую разницу (diff) для файла.

### `getLastCommit(repoRoot)`
*   **Что делает:** Получает хэш и сообщение последнего коммита.
*   **Как работает:** Запускает `git log -1 --format=%h%x09%s`.
    *   `%h` — короткий хэш.
    *   `%x09` — табуляция (безопасный разделитель).
    *   `%s` — сообщение.

### `getFileHistory(repoRoot, relPath)`
*   **Что делает:** Возвращает историю последних 5 коммитов конкретного файла.
*   **Формат:** `%h%x09%an%x09%ad%x09%s` (хэш, автор, дата, сообщение).

### `getCommitDetails()` и `getCommitSummary()`
*   **Что делают:** Вызывают `git show <hash>` (полный diff) и `git show --stat <hash>` (краткая сводка изменённых файлов).

---

## 3. Модуль `src/extension.ts` (Логика и интерфейс)

Этот файл связывает Git и VS Code (диалоги, палитра команд, панель Output).

### Вспомогательные функции

*   **`showInOutput(title, text)`** — очищает канал `outputChannel` и пишет туда текст. Использует `outputChannel.show(true)`, чтобы не забирать фокус у редактора кода.
*   **`getActiveFileContext()`** — ищет открытый файл, проверяет, открыта ли папка в VS Code, и лежит ли файл внутри этой папки. Возвращает корень репозитория (`repoRoot`) и путь файла относительно корня (`relPath`).
*   **`checkGitIsReady(repoRoot)`** — проверяет, что папка является Git-репозиторием (`rev-parse --is-inside-work-tree`), и что настроены `user.name` и `user.email`. Без этого Git не даст сделать коммит.
*   **`confirmCommitWithDiff()`** — получает diff, выводит его в Output, и показывает модальное окно (`modal: true`), блокирующее интерфейс до нажатия «Да» или «Нет».
*   **`askCommitMessage()`** — показывает `showInputBox` с валидацией. Если сообщение пустое или длиннее 200 символов, под полем загорается красная ошибка.

### Основные команды

**1. Команда `quickCommit.commit` (через `commitCurrentFile`)**
Сценарий работы:
1. Проверяет контекст (`getActiveFileContext`).
2. Проверяет готовность Git (`checkGitIsReady`).
3. Проверяет, есть ли изменения (`getFileStatus`).
4. Показывает diff и спрашивает подтверждение.
5. Спрашивает сообщение коммита.
6. Выполняет `git add -- <путь>`.
7. Выполняет `git commit -m "..." -- <путь>`.
8. Показывает уведомление об успехе с хэшем и кнопкой «Показать diff».

**2. Команда `quickCommit.showHistory` (через `showFileHistory`)**
1. Получает историю файла (`getFileHistory`).
2. Формирует список для `QuickPick` с иконкой `$(git-commit)`.
3. При выборе коммита вызывает `getCommitSummary` и выводит результат в панель Output.
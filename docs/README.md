# Техническая документация плагина Quick Commit

**Плагин:** Quick Commit (VS Code extension)
**Репозиторий:** https://github.com/shakhmatovanton/isrpo_laba3

## 1. Архитектура VS Code и как работает плагин

**Как плагин запускается:**
1. При старте VS Code читает файл `package.json` плагина.
2. Он видит там команды (в разделе `contributes.commands`).
3. Плагин **не активируется сразу**. VS Code ждёт, пока пользователь вызовет команду (это называется *lazy activation*).
4. Когда пользователь нажимает `Ctrl+Shift+P` → `Quick Commit`, VS Code загружает код плагина и вызывает функцию `activate()`.

**`context.subscriptions`**
Когда VS Code вызывает `activate(context)`, он передаёт объект `context`. У него есть массив `subscriptions`. VS Code **автоматически очистит** содержимое, когда плагин выключится. Это необходимо, чтобы не произошла утечка памяти.

---

## 2. Модуль `src/git.ts` (работа с Git)

Все обращения к Git в плагине идут только через этот файл — если понадобится что-то поменять в том, как мы вызываем git, искать нужно здесь.

### `runGit(args, cwd)`

```typescript
export async function runGit(args: string[], cwd: string): Promise<GitResult>
```

**Что делает:** запускает команду Git как дочерний процесс и возвращает результат.

**Параметры:**
- `args` — массив аргументов (например `['status', '--porcelain']`).
- `cwd` — папка, в которой нужно выполнить команду (Current Working Directory).

**Как работает внутри:**
- Использует `execFileAsync` (обёртка над `child_process.execFile`).
- В опциях передаёт `env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }`. Если Git захочет запросить пароль, он не зависнет в фоновом режиме, а сразу завершится с ошибкой.
- Оборачивает вызов в `try/catch`. Если Git выдал ошибку, возвращает `{ ok: false, error: ... }`, иначе `{ ok: true, stdout: ... }`.

**Пример вызова:**
```typescript
const res = await runGit(['status', '--porcelain'], '/home/user/project');
if (res.ok) console.log(res.stdout);
```

### `getFileStatus(repoRoot, relPath)`

```typescript
export async function getFileStatus(repoRoot: string, relPath: string): Promise<'modified' | 'untracked' | 'clean'>
```

**Что делает:** проверяет, есть ли изменения в конкретном файле.

**Как работает:**
- Вызывает `git status --porcelain -- <путь>`.
- Флаг `--porcelain` заставляет Git выдать ответ в строгом, машиночитаемом формате.
- Если вывод пустой — файл не менялся (`clean`).
- Если начинается с `??` — файл новый, Git его ещё не отслеживает (`untracked`).
- Иначе — файл изменён (`modified`).

**Зачем нужно:** чтобы не давать пользователю делать пустой коммит.

**Пример вызова:**
```typescript
const status = await getFileStatus('/home/user/project', 'src/app.ts');
// 'modified' | 'untracked' | 'clean'
```

### `getFileDiff(repoRoot, relPath)`

```typescript
export async function getFileDiff(repoRoot: string, relPath: string): Promise<string>
```

**Что делает:** возвращает текстовую разницу (`git diff`) для файла — то, что показывается пользователю перед подтверждением коммита.

**Пример вызова:**
```typescript
const diff = await getFileDiff('/home/user/project', 'src/app.ts');
```

### `getLastCommit(repoRoot)`

```typescript
export async function getLastCommit(repoRoot: string): Promise<{ hash: string; message: string }>
```

**Что делает:** получает хэш и сообщение последнего коммита.

**Как работает:** запускает `git log -1 --format=%h%x09%s`.
- `%h` — короткий хэш.
- `%x09` — табуляция (безопасный разделитель, не встречается в обычном тексте).
- `%s` — сообщение коммита.

**Пример вызова:**
```typescript
const { hash, message } = await getLastCommit('/home/user/project');
```

### `getFileHistory(repoRoot, relPath)`

```typescript
export async function getFileHistory(repoRoot: string, relPath: string): Promise<FileHistoryEntry[]>
```

**Что делает:** возвращает историю последних 5 коммитов конкретного файла.

**Формат:** `%h%x09%an%x09%ad%x09%s` (хэш, автор, дата, сообщение).

**Пример вызова:**
```typescript
const history = await getFileHistory('/home/user/project', 'src/app.ts');
// [{ hash, author, date, message }, ...]
```

### `getCommitDetails(repoRoot, hash)` и `getCommitSummary(repoRoot, hash)`

```typescript
export async function getCommitDetails(repoRoot: string, hash: string): Promise<string>
export async function getCommitSummary(repoRoot: string, hash: string): Promise<string>
```

**Что делают:** вызывают `git show <hash>` (полный diff коммита) и `git show --stat <hash>` (краткая сводка изменённых файлов) соответственно.

**Пример вызова:**
```typescript
const fullDiff = await getCommitDetails('/home/user/project', 'a1b2c3d');
const summary = await getCommitSummary('/home/user/project', 'a1b2c3d');
```

---

## 3. Модуль `src/extension.ts` (логика и интерфейс)

Этот файл связывает Git и VS Code (диалоги, палитра команд, панель Output). В отличие от `git.ts`, здесь нет ни одного прямого обращения к `git` — только вызовы готовых функций оттуда.

### Вспомогательные функции

- **`showInOutput(title, text)`** — очищает канал `outputChannel` и пишет туда текст. Использует `outputChannel.show(true)`, чтобы не забирать фокус у редактора кода.
- **`getActiveFileContext()`** — ищет открытый файл, проверяет, открыта ли папка в VS Code, и лежит ли файл внутри этой папки. Возвращает `{ repoRoot, relPath }` или `null`, если что-то не так.
- **`checkGitIsReady(repoRoot)`** — проверяет, что папка является Git-репозиторием (`rev-parse --is-inside-work-tree`), и что настроены `user.name` и `user.email`. Без этого Git не даст сделать коммит.
- **`confirmCommitWithDiff(repoRoot, relPath)`** — получает diff, выводит его в Output, и показывает модальное окно (`modal: true`), блокирующее интерфейс до нажатия «Да» или «Нет».
- **`askCommitMessage()`** — показывает `showInputBox` с валидацией. Если сообщение пустое или длиннее 200 символов, под полем загорается ошибка.

### Основные команды

**1. Команда `quickCommit.commit` (обработчик — `commitCurrentFile`)**

Сценарий работы:
1. Проверяет контекст (`getActiveFileContext`).
2. Проверяет готовность Git (`checkGitIsReady`).
3. Проверяет, есть ли изменения (`getFileStatus`).
4. Показывает diff и спрашивает подтверждение (`confirmCommitWithDiff`).
5. Спрашивает сообщение коммита (`askCommitMessage`).
6. Выполняет `git add -- <путь>`.
7. Выполняет `git commit -m "..." -- <путь>`.
8. Показывает уведомление об успехе с хэшем и кнопкой «Показать diff».

**2. Команда `quickCommit.showHistory` (обработчик — `showFileHistory`)**

1. Получает историю файла (`getFileHistory`).
2. Формирует список для `QuickPick` с иконкой `$(git-commit)`.
3. При выборе коммита вызывает `getCommitSummary` и выводит результат в панель Output.
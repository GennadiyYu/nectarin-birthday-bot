import initialSchema from "../migrations/0001_schema.sql";

interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  TIME_ZONE?: string;
  REMINDER_HOUR?: string;
  BOT_USERNAME?: string;
  OWNER_USERNAME?: string;
}

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TgChat = { id: number; type: string };
type TgMessage = { message_id: number; chat: TgChat; from?: TgUser; text?: string };
type TgCallback = { id: string; from: TgUser; message?: TgMessage; data?: string };
type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallback };
type InlineButton = { text: string; callback_data?: string; url?: string };
type InlineMarkup = { inline_keyboard: InlineButton[][] };

type SessionRow = { flow: string; step: string; data_json: string };
type UnitRow = { id: number; name: string; manager_name: string | null; active: number };
type EmployeeRow = {
  id: number;
  full_name: string;
  birthday_mmdd: string;
  birth_year: number | null;
  telegram_username: string | null;
  telegram_user_id: number | null;
  invite_code: string;
  unit_id: number;
  active: number;
  unit_name?: string;
};
type ClientRow = {
  id: number;
  full_name: string;
  birthday_mmdd: string;
  birth_year: number | null;
  company: string | null;
  responsible: string | null;
  note: string | null;
  active: number;
};

const REMINDER_LEADS = [7, 3, 0];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      try {
        await checkDatabase(env);
        const bot = await checkTelegramBot(env);
        const webhook = await tgCall(env, "getWebhookInfo", {}) as { url: string; pending_update_count: number; last_error_date?: number };
        const ok = webhook.url === `${url.origin}/webhook`;
        return Response.json({ ok, service: "nectarin-birthday-bot", version: "0.2.2", database: "ready", bot_username: bot.username, webhook_url: webhook.url, pending_updates: webhook.pending_update_count, last_delivery_error_at: webhook.last_error_date || null }, { status: ok ? 200 : 503 });
      } catch (error) {
        console.error("health check failed", error);
        return Response.json({ ok: false, service: "nectarin-birthday-bot", version: "0.2.2", error: publicError(error) }, { status: 503 });
      }
    }

    if (request.method === "GET" && url.pathname === "/") {
      try {
        await ensureDatabase(env);
        await checkTelegramBot(env);
        const webhookUrl = `${url.origin}/webhook`;
        await ensureTelegramWebhook(env, webhookUrl);
        const username = (env.BOT_USERNAME || "").replace(/^@/, "").trim();
        const owner = (env.OWNER_USERNAME || "").replace(/^@/, "").trim();
        const botLink = username ? `https://t.me/${username}` : "https://t.me/";
        return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nectarin Birthday Bot</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0d10;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:620px;padding:32px;border:1px solid #2a2f38;border-radius:24px;background:#14181e}.ok{font-size:52px}h1{margin:10px 0}p{color:#c7ced8;line-height:1.5}.btn{display:inline-block;margin-top:12px;padding:14px 20px;border-radius:12px;background:#fff;color:#111;text-decoration:none;font-weight:700}code{background:#222831;padding:3px 6px;border-radius:6px}</style></head><body><div class="card"><div class="ok">✅</div><h1>Бот развёрнут</h1><p>Таблицы Cloudflare D1 проверены, токен Telegram-бота подтверждён, webhook настроен. Версия 0.2.2.</p><p>Владелец: <b>@${htmlEsc(owner || "не задан")}</b></p><p>Теперь откройте Telegram-бота и нажмите <b>Start</b>. Если ваш username совпадает с владельцем выше, бот автоматически выдаст вам права владельца.</p><a class="btn" href="${htmlEsc(botLink)}">Открыть бота в Telegram</a></div></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      } catch (error) {
        console.error("bootstrap failed", error);
        return new Response(`Ошибка запуска: ${publicError(error)}`, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const expected = await webhookSecret(env.TELEGRAM_BOT_TOKEN);
      if (!secret || secret !== expected) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = (await request.json()) as TgUpdate;
      try {
        await ensureDatabase(env);
        await handleUpdate(update, env);
      } catch (error) {
        console.error("handleUpdate failed", error);
        const chat = update.message?.chat || update.callback_query?.message?.chat;
        if (chat?.type === "private") {
          try {
            await tgSend(env, chat.id, "⚠️ Не удалось обработать сообщение. Администратору нужно проверить страницу запуска бота. После исправления отправьте /start ещё раз.");
          } catch {
            return new Response("Processing failed", { status: 503 });
          }
        } else {
          return new Response("Processing failed", { status: 503 });
        }
      }
      return new Response("OK");
    }

    return new Response("Nectarin Birthday Bot", { status: 200 });
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = zonedParts(new Date(), env.TIME_ZONE || "Europe/Moscow");
    const reminderHour = Number(env.REMINDER_HOUR || "9");
    if (now.hour !== reminderHour) return;
    await ensureDatabase(env);
    await runBirthdayReminders(env);
  },
} satisfies ExportedHandler<Env>;

const requiredTables = ["admins", "units", "employees", "clients", "sessions", "collections", "collection_responses", "notification_log"];
const databaseReady = new WeakMap<D1Database, Promise<void>>();

async function checkDatabase(env: Env): Promise<void> {
  if (!env.DB) throw new Error("DATABASE_BINDING_MISSING");
  const result = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
  const names = new Set(result.results.map(row => row.name));
  if (requiredTables.some(name => !names.has(name))) throw new Error("DATABASE_SCHEMA_MISSING");
}

async function ensureDatabase(env: Env): Promise<void> {
  if (!env.DB) throw new Error("DATABASE_BINDING_MISSING");
  let ready = databaseReady.get(env.DB);
  if (!ready) {
    ready = (async () => {
      try {
        await checkDatabase(env);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "DATABASE_SCHEMA_MISSING") throw error;
        // Only the bundled initial migration: it uses CREATE IF NOT EXISTS and INSERT OR IGNORE.
        const statements = initialSchema.split(";").map(sql => sql.trim()).filter(sql => sql && !/^PRAGMA\b/i.test(sql));
        await env.DB.batch(statements.map(sql => env.DB.prepare(sql)));
        await checkDatabase(env);
      }
    })();
    databaseReady.set(env.DB, ready);
  }
  try { await ready; } catch (error) { databaseReady.delete(env.DB); throw error; }
}

async function checkTelegramBot(env: Env): Promise<{ username: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_TOKEN_MISSING");
  const bot = await tgCall(env, "getMe", {}) as { username: string };
  const expected = (env.BOT_USERNAME || "").replace(/^@/, "").trim().toLowerCase();
  if (expected && bot.username.toLowerCase() !== expected) throw new Error("TELEGRAM_BOT_MISMATCH");
  return bot;
}

function publicError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    DATABASE_BINDING_MISSING: "Не подключена база D1: требуется привязка DB.",
    DATABASE_SCHEMA_MISSING: "В базе отсутствуют таблицы. Откройте главную страницу Worker для их создания.",
    TELEGRAM_TOKEN_MISSING: "Добавьте TELEGRAM_BOT_TOKEN в секреты Worker.",
    TELEGRAM_BOT_MISMATCH: "Токен принадлежит другому боту. Проверьте TELEGRAM_BOT_TOKEN и BOT_USERNAME.",
  };
  return messages[code] || "Проверка не пройдена. Подробности доступны в журнале Worker в Cloudflare.";
}

async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }
  if (update.message?.text && update.message.from) {
    await handleMessage(update.message, env);
  }
}

async function handleMessage(message: TgMessage, env: Env): Promise<void> {
  const text = (message.text || "").trim();
  const user = message.from!;
  const chatId = message.chat.id;

  if (message.chat.type !== "private") {
    if (text.startsWith("/start")) {
      await tgSend(env, chatId, "Пожалуйста, откройте бота в личных сообщениях.");
    }
    return;
  }

  if (text.startsWith("/start")) {
    const owner = await env.DB.prepare("SELECT telegram_user_id FROM admins WHERE role='owner' LIMIT 1").first<{ telegram_user_id: number }>();
    if (!owner) {
      const expectedOwner = (normalizeUsername(env.OWNER_USERNAME || "") || "").toLowerCase();
      const actualUser = (normalizeUsername(user.username || "") || "").toLowerCase();
      if (!expectedOwner || actualUser !== expectedOwner) {
        await tgSend(env, chatId, "🔒 Бот ещё не активирован владельцем. В Cloudflare при развёртывании должен быть указан Telegram username владельца.");
        return;
      }
      const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Owner";
      await env.DB.prepare(
        "INSERT INTO admins(telegram_user_id, username, full_name, role) VALUES(?,?,?,'owner')"
      ).bind(user.id, user.username || null, fullName).run();
      await tgSend(env, chatId, "✅ Вы автоматически назначены владельцем бота.");
    }

    const payload = text.split(/\s+/, 2)[1] || "";
    if (payload.startsWith("link_")) {
      await linkEmployee(payload.slice(5), user, chatId, env);
      return;
    }
    if (await isAdmin(user.id, env)) {
      await sendMainMenu(env, chatId);
      return;
    }
    const employee = await env.DB.prepare(
      "SELECT id, full_name FROM employees WHERE telegram_user_id=? AND active=1"
    ).bind(user.id).first<{ id: number; full_name: string }>();
    if (employee) {
      await tgSend(env, chatId, `👋 ${esc(employee.full_name)}, вы подключены к корпоративному боту. Здесь будут приходить сообщения по сборам и дням рождения.`);
    } else {
      await tgSend(env, chatId, "👋 Бот работает. Чтобы подключиться как сотрудник, откройте персональную ссылку, которую выдаёт администратор после добавления в базу.");
    }
    return;
  }

  if (!(await isAdmin(user.id, env))) {
    await tgSend(env, chatId, "Команды управления доступны администраторам. Если вы сотрудник — дождитесь сообщений по сборам.");
    return;
  }

  if (text === "/menu" || text === "/cancel") {
    await clearSession(user.id, env);
    await sendMainMenu(env, chatId);
    return;
  }

  const session = await getSession(user.id, env);
  if (session) {
    await handleSessionInput(message, session, env);
    return;
  }

  await handleAiMessage(text, chatId, user.id, env);
}

async function handleCallback(cb: TgCallback, env: Env): Promise<void> {
  const data = cb.data || "";
  const chatId = cb.message?.chat.id;
  if (!chatId) return;

  if (data.startsWith("colresp:")) {
    await handleCollectionResponse(cb, env);
    return;
  }

  if (!(await isAdmin(cb.from.id, env))) {
    await tgAnswerCb(env, cb.id, "Нет доступа");
    return;
  }

  await tgAnswerCb(env, cb.id, "");

  if (data === "main") return sendMainMenu(env, chatId);
  if (data === "main:employees") return sendEmployeesMenu(env, chatId);
  if (data === "main:clients") return sendClientsMenu(env, chatId);
  if (data === "main:units") return sendUnitsMenu(env, chatId);
  if (data === "main:upcoming") return sendUpcoming(env, chatId, 30);
  if (data === "main:collections") return sendCollections(env, chatId);
  if (data === "main:help") {
    return tgSend(env, chatId,
      "🤖 <b>Свободные команды Gemini</b>\n\n" +
      "Можно писать обычным текстом, например:\n" +
      "• Добавь сотрудника Тестового Сотрудника, ДР 14 октября, юнит Основной юнит\n" +
      "• Добавь клиента Тестового Клиента из Haval, ДР 3 марта\n" +
      "• Покажи ближайшие дни рождения\n" +
      "• Подготовь короткое поздравление клиенту\n\n" +
      "Удаление всегда требует подтверждения кнопкой.",
      keyboard([[{ text: "⬅️ Меню", callback_data: "main" }]])
    );
  }

  if (data === "emp:add") {
    await setSession(cb.from.id, "add_employee", "name", {}, env);
    return tgSend(env, chatId, "👤 Введите ФИО сотрудника.\n\nДля отмены: /cancel");
  }
  if (data === "emp:list") return sendEmployeeList(env, chatId);
  if (data.startsWith("emp:view:")) return sendEmployeeCard(env, chatId, Number(data.split(":")[2]));
  if (data.startsWith("emp:delete:yes:")) {
    const id = Number(data.split(":")[3]);
    await env.DB.prepare("UPDATE employees SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
    await tgSend(env, chatId, "✅ Сотрудник удалён из активной базы.");
    return sendEmployeeList(env, chatId);
  }
  if (data.startsWith("emp:delete:")) {
    const id = Number(data.split(":")[2]);
    const e = await getEmployee(id, env);
    if (!e) return tgSend(env, chatId, "Сотрудник не найден.");
    return tgSend(env, chatId, `⚠️ Удалить из активной базы <b>${esc(e.full_name)}</b>?\nИстория сохранится, сотрудник станет неактивным.`,
      keyboard([[{ text: "✅ Удалить", callback_data: `emp:delete:yes:${id}` }, { text: "Отмена", callback_data: `emp:view:${id}` }]])
    );
  }
  if (data.startsWith("emp:edit:")) {
    const id = Number(data.split(":")[2]);
    return tgSend(env, chatId, "Что изменить?", keyboard([
      [{ text: "ФИО", callback_data: `emp:editname:${id}` }, { text: "ДР", callback_data: `emp:editbirthday:${id}` }],
      [{ text: "Telegram", callback_data: `emp:editusername:${id}` }, { text: "Юнит", callback_data: `emp:editunit:${id}` }],
      [{ text: "⬅️ Назад", callback_data: `emp:view:${id}` }],
    ]));
  }
  if (data.startsWith("emp:editname:")) {
    const id = Number(data.split(":")[2]);
    await setSession(cb.from.id, "edit_employee", "name", { id }, env);
    return tgSend(env, chatId, "Введите новое ФИО:");
  }
  if (data.startsWith("emp:editbirthday:")) {
    const id = Number(data.split(":")[2]);
    await setSession(cb.from.id, "edit_employee", "birthday", { id }, env);
    return tgSend(env, chatId, "Введите новую дату рождения: ДД.ММ или ДД.ММ.ГГГГ");
  }
  if (data.startsWith("emp:editusername:")) {
    const id = Number(data.split(":")[2]);
    await setSession(cb.from.id, "edit_employee", "username", { id }, env);
    return tgSend(env, chatId, "Введите @username или - чтобы очистить:");
  }
  if (data.startsWith("emp:editunit:")) {
    const id = Number(data.split(":")[2]);
    return sendUnitPicker(env, chatId, `emp:setunit:${id}:`);
  }
  if (data.startsWith("emp:setunit:")) {
    const [, , empIdS, unitIdS] = data.split(":");
    await env.DB.prepare("UPDATE employees SET unit_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(Number(unitIdS), Number(empIdS)).run();
    await tgSend(env, chatId, "✅ Юнит изменён.");
    return sendEmployeeCard(env, chatId, Number(empIdS));
  }
  if (data.startsWith("emp:chooseunit:")) {
    const unitId = Number(data.split(":")[2]);
    const session = await getSession(cb.from.id, env);
    if (!session || session.flow !== "add_employee") return tgSend(env, chatId, "Сессия добавления устарела. Начните заново.");
    const d = safeJson(session.data_json);
    await createEmployee({
      full_name: String(d.full_name),
      birthday_mmdd: String(d.birthday_mmdd),
      birth_year: d.birth_year ? Number(d.birth_year) : null,
      telegram_username: d.telegram_username ? String(d.telegram_username) : null,
      unit_id: unitId,
    }, env, chatId);
    await clearSession(cb.from.id, env);
    return;
  }

  if (data === "client:add") {
    await setSession(cb.from.id, "add_client", "name", {}, env);
    return tgSend(env, chatId, "🤝 Введите ФИО клиента.\n\nДля отмены: /cancel");
  }
  if (data === "client:list") return sendClientList(env, chatId);
  if (data.startsWith("client:view:")) return sendClientCard(env, chatId, Number(data.split(":")[2]));
  if (data.startsWith("client:delete:yes:")) {
    const id = Number(data.split(":")[3]);
    await env.DB.prepare("UPDATE clients SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
    await tgSend(env, chatId, "✅ Клиент удалён из активной базы.");
    return sendClientList(env, chatId);
  }
  if (data.startsWith("client:delete:")) {
    const id = Number(data.split(":")[2]);
    const c = await getClient(id, env);
    if (!c) return tgSend(env, chatId, "Клиент не найден.");
    return tgSend(env, chatId, `⚠️ Удалить из активной базы <b>${esc(c.full_name)}</b>?`, keyboard([
      [{ text: "✅ Удалить", callback_data: `client:delete:yes:${id}` }, { text: "Отмена", callback_data: `client:view:${id}` }],
    ]));
  }
  if (data.startsWith("client:edit:")) {
    const id = Number(data.split(":")[2]);
    return tgSend(env, chatId, "Что изменить?", keyboard([
      [{ text: "ФИО", callback_data: `client:editfield:${id}:name` }, { text: "ДР", callback_data: `client:editfield:${id}:birthday` }],
      [{ text: "Компания", callback_data: `client:editfield:${id}:company` }, { text: "Ответственный", callback_data: `client:editfield:${id}:responsible` }],
      [{ text: "Комментарий", callback_data: `client:editfield:${id}:note` }],
      [{ text: "⬅️ Назад", callback_data: `client:view:${id}` }],
    ]));
  }
  if (data.startsWith("client:editfield:")) {
    const [, , idS, field] = data.split(":");
    await setSession(cb.from.id, "edit_client", field, { id: Number(idS) }, env);
    const prompt = field === "birthday" ? "Введите дату рождения ДД.ММ или ДД.ММ.ГГГГ:" : "Введите новое значение (или - чтобы очистить поле):";
    return tgSend(env, chatId, prompt);
  }

  if (data === "unit:add") {
    await setSession(cb.from.id, "add_unit", "name", {}, env);
    return tgSend(env, chatId, "🏢 Введите название юнита:");
  }
  if (data === "unit:list") return sendUnitsList(env, chatId);

  if (data.startsWith("collection:view:")) {
    return sendCollectionCard(env, chatId, Number(data.split(":")[2]));
  }
}

async function handleSessionInput(message: TgMessage, session: SessionRow, env: Env): Promise<void> {
  const userId = message.from!.id;
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const data = safeJson(session.data_json);

  if (session.flow === "add_employee") {
    if (session.step === "name") {
      if (text.length < 2) return tgSend(env, chatId, "Введите нормальное ФИО.");
      data.full_name = text;
      await setSession(userId, "add_employee", "birthday", data, env);
      return tgSend(env, chatId, "🎂 Дата рождения: ДД.ММ или ДД.ММ.ГГГГ");
    }
    if (session.step === "birthday") {
      const b = parseBirthday(text);
      if (!b) return tgSend(env, chatId, "Не понял дату. Пример: 14.10 или 14.10.1992");
      data.birthday_mmdd = b.mmdd;
      data.birth_year = b.year;
      await setSession(userId, "add_employee", "username", data, env);
      return tgSend(env, chatId, "Telegram сотрудника: @username\nЕсли неизвестен — отправьте <b>-</b>.");
    }
    if (session.step === "username") {
      data.telegram_username = normalizeUsername(text);
      await setSession(userId, "add_employee", "unit", data, env);
      return sendUnitPicker(env, chatId, "emp:chooseunit:");
    }
  }

  if (session.flow === "add_client") {
    if (session.step === "name") {
      data.full_name = text;
      await setSession(userId, "add_client", "birthday", data, env);
      return tgSend(env, chatId, "🎂 Дата рождения клиента: ДД.ММ или ДД.ММ.ГГГГ");
    }
    if (session.step === "birthday") {
      const b = parseBirthday(text);
      if (!b) return tgSend(env, chatId, "Не понял дату. Пример: 03.03 или 03.03.1988");
      data.birthday_mmdd = b.mmdd;
      data.birth_year = b.year;
      await setSession(userId, "add_client", "company", data, env);
      return tgSend(env, chatId, "Компания клиента (или -):");
    }
    if (session.step === "company") {
      data.company = dashNull(text);
      await setSession(userId, "add_client", "responsible", data, env);
      return tgSend(env, chatId, "Ответственный за клиента (или -):");
    }
    if (session.step === "responsible") {
      data.responsible = dashNull(text);
      await setSession(userId, "add_client", "note", data, env);
      return tgSend(env, chatId, "Комментарий (или -):");
    }
    if (session.step === "note") {
      data.note = dashNull(text);
      const result = await env.DB.prepare(
        "INSERT INTO clients(full_name,birthday_mmdd,birth_year,company,responsible,note) VALUES(?,?,?,?,?,?)"
      ).bind(data.full_name, data.birthday_mmdd, data.birth_year || null, data.company || null, data.responsible || null, data.note || null).run();
      await clearSession(userId, env);
      await tgSend(env, chatId, `✅ Клиент добавлен. ID: ${result.meta.last_row_id}`);
      return sendClientCard(env, chatId, Number(result.meta.last_row_id));
    }
  }

  if (session.flow === "add_unit") {
    if (session.step === "name") {
      data.name = text;
      await setSession(userId, "add_unit", "manager", data, env);
      return tgSend(env, chatId, "Имя руководителя юнита (или -):");
    }
    if (session.step === "manager") {
      try {
        await env.DB.prepare("INSERT INTO units(name,manager_name) VALUES(?,?)").bind(data.name, dashNull(text)).run();
        await tgSend(env, chatId, "✅ Юнит добавлен.");
      } catch {
        await tgSend(env, chatId, "Не получилось добавить юнит. Возможно, такое название уже есть.");
      }
      await clearSession(userId, env);
      return sendUnitsList(env, chatId);
    }
  }

  if (session.flow === "edit_employee") {
    const id = Number(data.id);
    if (session.step === "name") {
      await env.DB.prepare("UPDATE employees SET full_name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(text, id).run();
    } else if (session.step === "birthday") {
      const b = parseBirthday(text);
      if (!b) return tgSend(env, chatId, "Не понял дату. Пример: 14.10");
      await env.DB.prepare("UPDATE employees SET birthday_mmdd=?, birth_year=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(b.mmdd, b.year, id).run();
    } else if (session.step === "username") {
      await env.DB.prepare("UPDATE employees SET telegram_username=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(normalizeUsername(text), id).run();
    }
    await clearSession(userId, env);
    await tgSend(env, chatId, "✅ Изменения сохранены.");
    return sendEmployeeCard(env, chatId, id);
  }

  if (session.flow === "edit_client") {
    const id = Number(data.id);
    const allowed = new Set(["name", "birthday", "company", "responsible", "note"]);
    if (!allowed.has(session.step)) {
      await clearSession(userId, env);
      return;
    }
    if (session.step === "birthday") {
      const b = parseBirthday(text);
      if (!b) return tgSend(env, chatId, "Не понял дату.");
      await env.DB.prepare("UPDATE clients SET birthday_mmdd=?, birth_year=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(b.mmdd, b.year, id).run();
    } else {
      const col = session.step === "name" ? "full_name" : session.step;
      const value = session.step === "name" ? text : dashNull(text);
      await env.DB.prepare(`UPDATE clients SET ${col}=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(value, id).run();
    }
    await clearSession(userId, env);
    await tgSend(env, chatId, "✅ Изменения сохранены.");
    return sendClientCard(env, chatId, id);
  }
}

async function sendMainMenu(env: Env, chatId: number): Promise<void> {
  await tgSend(env, chatId,
    "🎂 <b>Nectarin Birthday Bot</b>\n\nУправление днями рождения сотрудников и клиентов.",
    keyboard([
      [{ text: "👥 Сотрудники", callback_data: "main:employees" }, { text: "🤝 Клиенты", callback_data: "main:clients" }],
      [{ text: "🏢 Юниты", callback_data: "main:units" }, { text: "🎁 Сборы", callback_data: "main:collections" }],
      [{ text: "📅 Ближайшие ДР", callback_data: "main:upcoming" }],
      [{ text: "🤖 Как говорить с Gemini", callback_data: "main:help" }],
    ])
  );
}

async function sendEmployeesMenu(env: Env, chatId: number): Promise<void> {
  await tgSend(env, chatId, "👥 <b>Сотрудники</b>", keyboard([
    [{ text: "➕ Добавить", callback_data: "emp:add" }, { text: "📋 Список", callback_data: "emp:list" }],
    [{ text: "⬅️ Главное меню", callback_data: "main" }],
  ]));
}

async function sendClientsMenu(env: Env, chatId: number): Promise<void> {
  await tgSend(env, chatId, "🤝 <b>Клиенты</b>", keyboard([
    [{ text: "➕ Добавить", callback_data: "client:add" }, { text: "📋 Список", callback_data: "client:list" }],
    [{ text: "⬅️ Главное меню", callback_data: "main" }],
  ]));
}

async function sendUnitsMenu(env: Env, chatId: number): Promise<void> {
  await tgSend(env, chatId, "🏢 <b>Юниты</b>", keyboard([
    [{ text: "➕ Добавить юнит", callback_data: "unit:add" }, { text: "📋 Список", callback_data: "unit:list" }],
    [{ text: "⬅️ Главное меню", callback_data: "main" }],
  ]));
}

async function sendEmployeeList(env: Env, chatId: number): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT e.id,e.full_name,e.birthday_mmdd,e.telegram_user_id,u.name AS unit_name FROM employees e JOIN units u ON u.id=e.unit_id WHERE e.active=1 ORDER BY u.name,e.full_name LIMIT 40"
  ).all<{ id: number; full_name: string; birthday_mmdd: string; telegram_user_id: number | null; unit_name: string }>();
  if (!rows.results.length) {
    return tgSend(env, chatId, "Сотрудников пока нет.", keyboard([[{ text: "➕ Добавить", callback_data: "emp:add" }, { text: "⬅️ Назад", callback_data: "main:employees" }]]));
  }
  const buttons = rows.results.map(r => [{ text: `${r.full_name} · ${fmtMmdd(r.birthday_mmdd)}`, callback_data: `emp:view:${r.id}` }]);
  buttons.push([{ text: "➕ Добавить", callback_data: "emp:add" }, { text: "⬅️ Назад", callback_data: "main:employees" }]);
  await tgSend(env, chatId, `👥 <b>Активные сотрудники: ${rows.results.length}${rows.results.length === 40 ? "+" : ""}</b>`, keyboard(buttons));
}

async function sendEmployeeCard(env: Env, chatId: number, id: number): Promise<void> {
  const e = await getEmployee(id, env);
  if (!e) return tgSend(env, chatId, "Сотрудник не найден.");
  const unit = await env.DB.prepare("SELECT name FROM units WHERE id=?").bind(e.unit_id).first<{ name: string }>();
  const link = employeeLink(e, env);
  const text =
    `👤 <b>${esc(e.full_name)}</b>\n` +
    `🎂 ${fmtMmdd(e.birthday_mmdd)}${e.birth_year ? `.${e.birth_year}` : ""}\n` +
    `🏢 ${esc(unit?.name || "—")}\n` +
    `Telegram: ${e.telegram_username ? `@${esc(e.telegram_username)}` : "—"}\n` +
    `Привязка бота: ${e.telegram_user_id ? "✅" : "❌"}` +
    (link ? `\n\n🔗 <b>Ссылка для сотрудника:</b>\n${esc(link)}` : "");
  await tgSend(env, chatId, text, keyboard([
    [{ text: "✏️ Изменить", callback_data: `emp:edit:${id}` }, { text: "🗑 Удалить", callback_data: `emp:delete:${id}` }],
    [{ text: "⬅️ К списку", callback_data: "emp:list" }],
  ]));
}

async function sendClientList(env: Env, chatId: number): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id,full_name,birthday_mmdd,company FROM clients WHERE active=1 ORDER BY full_name LIMIT 40"
  ).all<{ id: number; full_name: string; birthday_mmdd: string; company: string | null }>();
  if (!rows.results.length) {
    return tgSend(env, chatId, "Клиентов пока нет.", keyboard([[{ text: "➕ Добавить", callback_data: "client:add" }, { text: "⬅️ Назад", callback_data: "main:clients" }]]));
  }
  const buttons = rows.results.map(r => [{ text: `${r.full_name} · ${fmtMmdd(r.birthday_mmdd)}`, callback_data: `client:view:${r.id}` }]);
  buttons.push([{ text: "➕ Добавить", callback_data: "client:add" }, { text: "⬅️ Назад", callback_data: "main:clients" }]);
  await tgSend(env, chatId, `🤝 <b>Активные клиенты: ${rows.results.length}${rows.results.length === 40 ? "+" : ""}</b>`, keyboard(buttons));
}

async function sendClientCard(env: Env, chatId: number, id: number): Promise<void> {
  const c = await getClient(id, env);
  if (!c) return tgSend(env, chatId, "Клиент не найден.");
  const text =
    `🤝 <b>${esc(c.full_name)}</b>\n` +
    `🎂 ${fmtMmdd(c.birthday_mmdd)}${c.birth_year ? `.${c.birth_year}` : ""}\n` +
    `🏢 ${esc(c.company || "—")}\n` +
    `👤 Ответственный: ${esc(c.responsible || "—")}\n` +
    `📝 ${esc(c.note || "—")}`;
  await tgSend(env, chatId, text, keyboard([
    [{ text: "✏️ Изменить", callback_data: `client:edit:${id}` }, { text: "🗑 Удалить", callback_data: `client:delete:${id}` }],
    [{ text: "⬅️ К списку", callback_data: "client:list" }],
  ]));
}

async function sendUnitsList(env: Env, chatId: number): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT u.id,u.name,u.manager_name,COUNT(e.id) AS employee_count FROM units u LEFT JOIN employees e ON e.unit_id=u.id AND e.active=1 WHERE u.active=1 GROUP BY u.id ORDER BY u.name"
  ).all<{ id: number; name: string; manager_name: string | null; employee_count: number }>();
  const text = rows.results.length
    ? "🏢 <b>Юниты</b>\n\n" + rows.results.map(r => `• <b>${esc(r.name)}</b> — ${r.employee_count} чел.${r.manager_name ? `\n  Руководитель: ${esc(r.manager_name)}` : ""}`).join("\n")
    : "Юнитов пока нет.";
  await tgSend(env, chatId, text, keyboard([[{ text: "➕ Добавить", callback_data: "unit:add" }, { text: "⬅️ Назад", callback_data: "main:units" }]]));
}

async function sendUnitPicker(env: Env, chatId: number, prefix: string): Promise<void> {
  const units = await env.DB.prepare("SELECT id,name FROM units WHERE active=1 ORDER BY name").all<{ id: number; name: string }>();
  if (!units.results.length) return tgSend(env, chatId, "Сначала создайте хотя бы один юнит.");
  const buttons = units.results.map(u => [{ text: u.name, callback_data: `${prefix}${u.id}` }]);
  buttons.push([{ text: "❌ Отмена", callback_data: "main:employees" }]);
  await tgSend(env, chatId, "🏢 Выберите юнит:", keyboard(buttons));
}

async function sendUpcoming(env: Env, chatId: number, days: number): Promise<void> {
  const items = await getUpcoming(env, days);
  if (!items.length) {
    return tgSend(env, chatId, `На ближайшие ${days} дней дней рождения нет.`, keyboard([[{ text: "⬅️ Меню", callback_data: "main" }]]));
  }
  const lines = items.slice(0, 50).map(i => `${i.days === 0 ? "🎉 Сегодня" : `через ${i.days} дн.`} — <b>${esc(i.name)}</b> · ${fmtMmdd(i.mmdd)} · ${i.type === "employee" ? "сотрудник" : "клиент"}${i.extra ? ` · ${esc(i.extra)}` : ""}`);
  await tgSend(env, chatId, `📅 <b>Ближайшие ДР (${days} дней)</b>\n\n${lines.join("\n")}`, keyboard([[{ text: "⬅️ Меню", callback_data: "main" }]]));
}

async function sendCollections(env: Env, chatId: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT c.id,c.event_date,e.full_name,u.name AS unit_name,
      SUM(CASE WHEN r.status='paid' THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN r.status='joined' THEN 1 ELSE 0 END) AS joined,
      SUM(CASE WHEN r.status='declined' THEN 1 ELSE 0 END) AS declined,
      COUNT(r.employee_id) AS total
     FROM collections c
     JOIN employees e ON e.id=c.birthday_employee_id
     JOIN units u ON u.id=c.unit_id
     LEFT JOIN collection_responses r ON r.collection_id=c.id
     WHERE c.status='open'
     GROUP BY c.id ORDER BY c.event_date LIMIT 20`
  ).all<{ id: number; event_date: string; full_name: string; unit_name: string; paid: number; joined: number; declined: number; total: number }>();
  if (!rows.results.length) {
    return tgSend(env, chatId, "🎁 Активных сборов сейчас нет.", keyboard([[{ text: "⬅️ Меню", callback_data: "main" }]]));
  }
  const buttons = rows.results.map(r => [{ text: `${r.full_name} · ${r.event_date} · 💸${r.paid}/${r.total}`, callback_data: `collection:view:${r.id}` }]);
  buttons.push([{ text: "⬅️ Меню", callback_data: "main" }]);
  await tgSend(env, chatId, "🎁 <b>Активные сборы</b>", keyboard(buttons));
}

async function sendCollectionCard(env: Env, chatId: number, collectionId: number): Promise<void> {
  const c = await env.DB.prepare(
    `SELECT c.id,c.event_date,e.full_name,u.name AS unit_name
     FROM collections c JOIN employees e ON e.id=c.birthday_employee_id JOIN units u ON u.id=c.unit_id WHERE c.id=?`
  ).bind(collectionId).first<{ id: number; event_date: string; full_name: string; unit_name: string }>();
  if (!c) return tgSend(env, chatId, "Сбор не найден.");
  const s = await env.DB.prepare(
    `SELECT status,COUNT(*) AS cnt FROM collection_responses WHERE collection_id=? GROUP BY status`
  ).bind(collectionId).all<{ status: string; cnt: number }>();
  const map = Object.fromEntries(s.results.map(x => [x.status, x.cnt]));
  const text = `🎁 <b>Сбор: ${esc(c.full_name)}</b>\n📅 ${esc(c.event_date)}\n🏢 ${esc(c.unit_name)}\n\n👥 Приглашено: ${(map.invited || 0) + (map.joined || 0) + (map.paid || 0) + (map.declined || 0)}\n✅ Участвуют: ${map.joined || 0}\n💸 Перевели: ${map.paid || 0}\n❌ Не участвуют: ${map.declined || 0}\n⏳ Не ответили: ${map.invited || 0}`;
  await tgSend(env, chatId, text, keyboard([[{ text: "⬅️ К сборам", callback_data: "main:collections" }]]));
}

async function createEmployee(input: { full_name: string; birthday_mmdd: string; birth_year: number | null; telegram_username: string | null; unit_id: number }, env: Env, chatId: number): Promise<void> {
  const invite = randomCode();
  const result = await env.DB.prepare(
    "INSERT INTO employees(full_name,birthday_mmdd,birth_year,telegram_username,invite_code,unit_id) VALUES(?,?,?,?,?,?)"
  ).bind(input.full_name, input.birthday_mmdd, input.birth_year, input.telegram_username, invite, input.unit_id).run();
  const id = Number(result.meta.last_row_id);
  await tgSend(env, chatId, `✅ Сотрудник добавлен. ID: ${id}`);
  await sendEmployeeCard(env, chatId, id);
}

async function linkEmployee(code: string, user: TgUser, chatId: number, env: Env): Promise<void> {
  const employee = await env.DB.prepare(
    "SELECT id,full_name,telegram_user_id FROM employees WHERE invite_code=? AND active=1"
  ).bind(code).first<{ id: number; full_name: string; telegram_user_id: number | null }>();
  if (!employee) {
    await tgSend(env, chatId, "Ссылка недействительна или сотрудник уже удалён из базы.");
    return;
  }
  if (employee.telegram_user_id && employee.telegram_user_id !== user.id) {
    await tgSend(env, chatId, "Эта ссылка уже привязана к другому Telegram-аккаунту. Обратитесь к администратору.");
    return;
  }
  await env.DB.prepare(
    "UPDATE employees SET telegram_user_id=?, telegram_username=COALESCE(?,telegram_username), updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(user.id, user.username || null, employee.id).run();
  await tgSend(env, chatId, `✅ Готово, <b>${esc(employee.full_name)}</b>. Ваш Telegram привязан. Теперь бот сможет присылать вам сообщения по сборам.`);
}

async function handleCollectionResponse(cb: TgCallback, env: Env): Promise<void> {
  const [, collectionIdS, status] = (cb.data || "").split(":");
  const collectionId = Number(collectionIdS);
  if (!new Set(["joined", "paid", "declined"]).has(status)) return;
  const employee = await env.DB.prepare("SELECT id FROM employees WHERE telegram_user_id=? AND active=1")
    .bind(cb.from.id).first<{ id: number }>();
  if (!employee) {
    await tgAnswerCb(env, cb.id, "Ваш Telegram не привязан к сотруднику");
    return;
  }
  const member = await env.DB.prepare("SELECT status FROM collection_responses WHERE collection_id=? AND employee_id=?")
    .bind(collectionId, employee.id).first();
  if (!member) {
    await tgAnswerCb(env, cb.id, "Вы не участвуете в этом сборе");
    return;
  }
  await env.DB.prepare("UPDATE collection_responses SET status=?, updated_at=CURRENT_TIMESTAMP WHERE collection_id=? AND employee_id=?")
    .bind(status, collectionId, employee.id).run();
  const label = status === "paid" ? "Отмечено: перевёл 💸" : status === "joined" ? "Отмечено: участвую ✅" : "Отмечено: не участвую";
  await tgAnswerCb(env, cb.id, label);
}

async function runBirthdayReminders(env: Env): Promise<{ ok: boolean; sent: number; collections_created: number }> {
  const today = localDateString(new Date(), env.TIME_ZONE || "Europe/Moscow");
  const employees = await env.DB.prepare(
    "SELECT e.id,e.full_name,e.birthday_mmdd,e.unit_id,e.telegram_user_id,u.name AS unit_name FROM employees e JOIN units u ON u.id=e.unit_id WHERE e.active=1"
  ).all<EmployeeRow & { unit_name: string }>();
  const clients = await env.DB.prepare("SELECT id,full_name,birthday_mmdd,company,responsible FROM clients WHERE active=1").all<ClientRow>();
  const admins = await env.DB.prepare("SELECT telegram_user_id FROM admins").all<{ telegram_user_id: number }>();
  let sent = 0;
  let collectionsCreated = 0;

  for (const lead of REMINDER_LEADS) {
    for (const e of employees.results) {
      if (daysUntilBirthday(e.birthday_mmdd, today) !== lead) continue;
      const eventDate = nextBirthdayDate(e.birthday_mmdd, today);
      for (const a of admins.results) {
        const text = lead === 0
          ? `🎉 <b>Сегодня день рождения сотрудника!</b>\n${esc(e.full_name)}\n🏢 ${esc(e.unit_name || "")}`
          : `🎂 Через <b>${lead}</b> дн. ДР сотрудника\n<b>${esc(e.full_name)}</b>\n🏢 ${esc(e.unit_name || "")}`;
        if (await sendOnce(env, "birthday_admin", "employee", e.id, a.telegram_user_id, eventDate, lead, text)) sent++;
      }

      if (lead === 7) {
        const created = await ensureCollection(e, eventDate, env);
        if (created.created) collectionsCreated++;
        sent += await inviteCollectionParticipants(created.id, e, env);
      }
      if (lead === 3) {
        const c = await env.DB.prepare("SELECT id FROM collections WHERE birthday_employee_id=? AND event_date=?")
          .bind(e.id, eventDate).first<{ id: number }>();
        if (c) sent += await remindCollectionParticipants(c.id, e, env);
      }
    }

    for (const c of clients.results) {
      if (daysUntilBirthday(c.birthday_mmdd, today) !== lead) continue;
      const eventDate = nextBirthdayDate(c.birthday_mmdd, today);
      for (const a of admins.results) {
        const text = lead === 0
          ? `🎉 <b>Сегодня день рождения клиента!</b>\n${esc(c.full_name)}${c.company ? `\n🏢 ${esc(c.company)}` : ""}${c.responsible ? `\n👤 Ответственный: ${esc(c.responsible)}` : ""}`
          : `🎂 Через <b>${lead}</b> дн. ДР клиента\n<b>${esc(c.full_name)}</b>${c.company ? `\n🏢 ${esc(c.company)}` : ""}${c.responsible ? `\n👤 Ответственный: ${esc(c.responsible)}` : ""}`;
        if (await sendOnce(env, "birthday_admin", "client", c.id, a.telegram_user_id, eventDate, lead, text)) sent++;
      }
    }
  }
  return { ok: true, sent, collections_created: collectionsCreated };
}

async function ensureCollection(e: EmployeeRow, eventDate: string, env: Env): Promise<{ id: number; created: boolean }> {
  const existing = await env.DB.prepare("SELECT id FROM collections WHERE birthday_employee_id=? AND event_date=?")
    .bind(e.id, eventDate).first<{ id: number }>();
  if (existing) return { id: existing.id, created: false };
  const r = await env.DB.prepare("INSERT INTO collections(birthday_employee_id,unit_id,event_date) VALUES(?,?,?)")
    .bind(e.id, e.unit_id, eventDate).run();
  return { id: Number(r.meta.last_row_id), created: true };
}

async function inviteCollectionParticipants(collectionId: number, birthdayEmployee: EmployeeRow, env: Env): Promise<number> {
  const members = await env.DB.prepare(
    "SELECT id,full_name,telegram_user_id FROM employees WHERE unit_id=? AND active=1 AND id<>?"
  ).bind(birthdayEmployee.unit_id, birthdayEmployee.id).all<{ id: number; full_name: string; telegram_user_id: number | null }>();
  let sent = 0;
  for (const m of members.results) {
    await env.DB.prepare("INSERT OR IGNORE INTO collection_responses(collection_id,employee_id,status) VALUES(?,?,'invited')")
      .bind(collectionId, m.id).run();
    if (!m.telegram_user_id) continue;
    const marker = await env.DB.prepare(
      "SELECT id FROM notification_log WHERE kind='collection_invite' AND person_type='employee' AND person_id=? AND target_chat_id=? AND event_date=(SELECT event_date FROM collections WHERE id=?) AND lead_days=7"
    ).bind(birthdayEmployee.id, m.telegram_user_id, collectionId).first();
    if (marker) continue;
    const c = await env.DB.prepare("SELECT event_date FROM collections WHERE id=?").bind(collectionId).first<{ event_date: string }>();
    const text = `🎁 <b>Сбор на день рождения</b>\n\nЧерез 7 дней день рождения у <b>${esc(birthdayEmployee.full_name)}</b>.\nВы в том же юните и приглашены в сбор.\n\nОтметьте статус:`;
    await tgSend(env, m.telegram_user_id, text, keyboard([
      [{ text: "✅ Участвую", callback_data: `colresp:${collectionId}:joined` }, { text: "💸 Перевёл", callback_data: `colresp:${collectionId}:paid` }],
      [{ text: "❌ Не участвую", callback_data: `colresp:${collectionId}:declined` }],
    ])).then(() => sent++).catch(err => console.error("collection invite failed", err));
    await env.DB.prepare(
      "INSERT OR IGNORE INTO notification_log(kind,person_type,person_id,target_chat_id,event_date,lead_days) VALUES('collection_invite','employee',?,?,?,7)"
    ).bind(birthdayEmployee.id, m.telegram_user_id, c?.event_date || "").run();
  }
  return sent;
}

async function remindCollectionParticipants(collectionId: number, birthdayEmployee: EmployeeRow, env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT e.id,e.telegram_user_id,r.status,c.event_date
     FROM collection_responses r JOIN employees e ON e.id=r.employee_id JOIN collections c ON c.id=r.collection_id
     WHERE r.collection_id=? AND e.telegram_user_id IS NOT NULL AND r.status IN ('invited','joined')`
  ).bind(collectionId).all<{ id: number; telegram_user_id: number; status: string; event_date: string }>();
  let sent = 0;
  for (const r of rows.results) {
    const text = `⏰ До дня рождения <b>${esc(birthdayEmployee.full_name)}</b> осталось 3 дня.${r.status === "joined" ? "\nВы отметили, что участвуете." : "\nВы ещё не ответили по сбору."}`;
    if (await sendOnce(env, "collection_reminder", "employee", birthdayEmployee.id, r.telegram_user_id, r.event_date, 3, text,
      keyboard([[{ text: "✅ Участвую", callback_data: `colresp:${collectionId}:joined` }, { text: "💸 Перевёл", callback_data: `colresp:${collectionId}:paid` }], [{ text: "❌ Не участвую", callback_data: `colresp:${collectionId}:declined` }]]))) sent++;
  }
  return sent;
}

async function sendOnce(env: Env, kind: string, personType: string, personId: number, targetChatId: number, eventDate: string, leadDays: number, text: string, replyMarkup?: InlineMarkup): Promise<boolean> {
  const exists = await env.DB.prepare(
    "SELECT id FROM notification_log WHERE kind=? AND person_type=? AND person_id=? AND target_chat_id=? AND event_date=? AND lead_days=?"
  ).bind(kind, personType, personId, targetChatId, eventDate, leadDays).first();
  if (exists) return false;
  try {
    await tgSend(env, targetChatId, text, replyMarkup);
    await env.DB.prepare(
      "INSERT INTO notification_log(kind,person_type,person_id,target_chat_id,event_date,lead_days) VALUES(?,?,?,?,?,?)"
    ).bind(kind, personType, personId, targetChatId, eventDate, leadDays).run();
    return true;
  } catch (error) {
    console.error("sendOnce failed", { kind, personType, personId, targetChatId, error });
    return false;
  }
}

async function handleAiMessage(text: string, chatId: number, adminId: number, env: Env): Promise<void> {
  if (!text) return;
  if (!env.GEMINI_API_KEY) {
    await tgSend(env, chatId, "Gemini пока не подключён. Используйте кнопки меню или добавьте секрет GEMINI_API_KEY.", keyboard([[{ text: "⬅️ Меню", callback_data: "main" }]]));
    return;
  }

  const tools = [
    {
      type: "function",
      name: "add_employee",
      description: "Добавить сотрудника в базу. Вызывать только когда известны ФИО, дата рождения и юнит.",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          birthday: { type: "string", description: "Дата рождения в понятном формате, например 14.10 или 14 октября 1990" },
          unit_name: { type: "string" },
          telegram_username: { type: "string" },
        },
        required: ["full_name", "birthday", "unit_name"],
      },
    },
    {
      type: "function",
      name: "add_client",
      description: "Добавить клиента в базу. Вызывать только когда известны ФИО и дата рождения.",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          birthday: { type: "string" },
          company: { type: "string" },
          responsible: { type: "string" },
          note: { type: "string" },
        },
        required: ["full_name", "birthday"],
      },
    },
    {
      type: "function",
      name: "list_upcoming_birthdays",
      description: "Показать ближайшие дни рождения сотрудников и клиентов.",
      parameters: { type: "object", properties: { days: { type: "integer", description: "Период 1-90 дней" } } },
    },
    {
      type: "function",
      name: "request_remove_employee",
      description: "Найти сотрудника для удаления. Никогда не удаляет без подтверждения кнопкой.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      type: "function",
      name: "request_remove_client",
      description: "Найти клиента для удаления. Никогда не удаляет без подтверждения кнопкой.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  ];

  const prompt =
    "Ты помощник внутреннего Telegram-бота Nectarin по дням рождения. Отвечай по-русски, коротко. " +
    "Если пользователь просит изменить базу — используй функции. Не выдумывай отсутствующие ФИО, даты или юниты. " +
    "Если данных недостаточно, просто задай уточняющий вопрос текстом. Удаление только через request_remove_* и подтверждение интерфейсом.\n\n" +
    `Сообщение администратора: ${text}`;

  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ model: env.GEMINI_MODEL || "gemini-3.8-flash", input: prompt, store: false, tools }),
    });
    if (!response.ok) {
      console.error("Gemini error", response.status, await response.text());
      await tgSend(env, chatId, "Gemini сейчас не ответил. Кнопочное управление продолжает работать.");
      return;
    }
    const json = await response.json() as { output_text?: string; steps?: Array<{ type: string; name?: string; arguments?: Record<string, unknown> }> };
    const fc = json.steps?.find(s => s.type === "function_call" && s.name);
    if (!fc?.name) {
      await tgSend(env, chatId, esc(json.output_text || "Не понял команду. Попробуйте сформулировать иначе."));
      return;
    }
    await executeAiTool(fc.name, fc.arguments || {}, chatId, adminId, env);
  } catch (error) {
    console.error("Gemini call failed", error);
    await tgSend(env, chatId, "Не удалось обратиться к Gemini. Используйте меню — база и напоминания от Gemini не зависят.");
  }
}

async function executeAiTool(name: string, args: Record<string, unknown>, chatId: number, _adminId: number, env: Env): Promise<void> {
  if (name === "add_employee") {
    const fullName = String(args.full_name || "").trim();
    const b = parseBirthdayNatural(String(args.birthday || ""));
    const unitName = String(args.unit_name || "").trim();
    if (!fullName || !b || !unitName) return tgSend(env, chatId, "Нужны ФИО, дата рождения и юнит.");
    const unit = await findUnitByName(unitName, env);
    if (!unit) {
      const units = await env.DB.prepare("SELECT name FROM units WHERE active=1 ORDER BY name").all<{ name: string }>();
      return tgSend(env, chatId, `Не нашёл юнит «${esc(unitName)}». Доступные: ${units.results.map(u => esc(u.name)).join(", ")}`);
    }
    await createEmployee({ full_name: fullName, birthday_mmdd: b.mmdd, birth_year: b.year, telegram_username: normalizeUsername(String(args.telegram_username || "-")), unit_id: unit.id }, env, chatId);
    return;
  }
  if (name === "add_client") {
    const fullName = String(args.full_name || "").trim();
    const b = parseBirthdayNatural(String(args.birthday || ""));
    if (!fullName || !b) return tgSend(env, chatId, "Нужны ФИО и дата рождения клиента.");
    const r = await env.DB.prepare("INSERT INTO clients(full_name,birthday_mmdd,birth_year,company,responsible,note) VALUES(?,?,?,?,?,?)")
      .bind(fullName, b.mmdd, b.year, dashNull(String(args.company || "-")), dashNull(String(args.responsible || "-")), dashNull(String(args.note || "-"))).run();
    await tgSend(env, chatId, "✅ Клиент добавлен.");
    return sendClientCard(env, chatId, Number(r.meta.last_row_id));
  }
  if (name === "list_upcoming_birthdays") {
    const days = Math.max(1, Math.min(90, Number(args.days || 30)));
    return sendUpcoming(env, chatId, days);
  }
  if (name === "request_remove_employee") {
    const matches = await searchEmployees(String(args.name || ""), env);
    if (!matches.length) return tgSend(env, chatId, "Сотрудник не найден.");
    const buttons = matches.slice(0, 8).map(e => [{ text: `🗑 ${e.full_name}`, callback_data: `emp:delete:${e.id}` }]);
    buttons.push([{ text: "Отмена", callback_data: "main" }]);
    return tgSend(env, chatId, "Выберите сотрудника. Перед удалением будет ещё одно подтверждение:", keyboard(buttons));
  }
  if (name === "request_remove_client") {
    const matches = await searchClients(String(args.name || ""), env);
    if (!matches.length) return tgSend(env, chatId, "Клиент не найден.");
    const buttons = matches.slice(0, 8).map(c => [{ text: `🗑 ${c.full_name}`, callback_data: `client:delete:${c.id}` }]);
    buttons.push([{ text: "Отмена", callback_data: "main" }]);
    return tgSend(env, chatId, "Выберите клиента. Перед удалением будет ещё одно подтверждение:", keyboard(buttons));
  }
  await tgSend(env, chatId, "Команда распознана, но такой функции пока нет в боте.");
}

async function getUpcoming(env: Env, days: number): Promise<Array<{ type: "employee" | "client"; id: number; name: string; mmdd: string; days: number; extra?: string }>> {
  const today = localDateString(new Date(), env.TIME_ZONE || "Europe/Moscow");
  const employees = await env.DB.prepare(
    "SELECT e.id,e.full_name,e.birthday_mmdd,u.name AS unit_name FROM employees e JOIN units u ON u.id=e.unit_id WHERE e.active=1"
  ).all<{ id: number; full_name: string; birthday_mmdd: string; unit_name: string }>();
  const clients = await env.DB.prepare("SELECT id,full_name,birthday_mmdd,company FROM clients WHERE active=1")
    .all<{ id: number; full_name: string; birthday_mmdd: string; company: string | null }>();
  const items = [
    ...employees.results.map(e => ({ type: "employee" as const, id: e.id, name: e.full_name, mmdd: e.birthday_mmdd, days: daysUntilBirthday(e.birthday_mmdd, today), extra: e.unit_name })),
    ...clients.results.map(c => ({ type: "client" as const, id: c.id, name: c.full_name, mmdd: c.birthday_mmdd, days: daysUntilBirthday(c.birthday_mmdd, today), extra: c.company || undefined })),
  ];
  return items.filter(i => i.days <= days).sort((a, b) => a.days - b.days || a.name.localeCompare(b.name, "ru"));
}

async function isAdmin(userId: number, env: Env): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS ok FROM admins WHERE telegram_user_id=?").bind(userId).first());
}

async function getSession(userId: number, env: Env): Promise<SessionRow | null> {
  return await env.DB.prepare("SELECT flow,step,data_json FROM sessions WHERE telegram_user_id=?").bind(userId).first<SessionRow>();
}

async function setSession(userId: number, flow: string, step: string, data: Record<string, unknown>, env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sessions(telegram_user_id,flow,step,data_json,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(telegram_user_id) DO UPDATE SET flow=excluded.flow,step=excluded.step,data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP`
  ).bind(userId, flow, step, JSON.stringify(data)).run();
}

async function clearSession(userId: number, env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE telegram_user_id=?").bind(userId).run();
}

async function getEmployee(id: number, env: Env): Promise<EmployeeRow | null> {
  return await env.DB.prepare("SELECT * FROM employees WHERE id=?").bind(id).first<EmployeeRow>();
}

async function getClient(id: number, env: Env): Promise<ClientRow | null> {
  return await env.DB.prepare("SELECT * FROM clients WHERE id=?").bind(id).first<ClientRow>();
}

async function searchEmployees(name: string, env: Env): Promise<Array<{ id: number; full_name: string }>> {
  const rows = await env.DB.prepare("SELECT id,full_name FROM employees WHERE active=1 ORDER BY full_name").all<{ id: number; full_name: string }>();
  const q = norm(name);
  return rows.results.filter(r => norm(r.full_name).includes(q));
}

async function searchClients(name: string, env: Env): Promise<Array<{ id: number; full_name: string }>> {
  const rows = await env.DB.prepare("SELECT id,full_name FROM clients WHERE active=1 ORDER BY full_name").all<{ id: number; full_name: string }>();
  const q = norm(name);
  return rows.results.filter(r => norm(r.full_name).includes(q));
}

async function findUnitByName(name: string, env: Env): Promise<UnitRow | null> {
  const units = await env.DB.prepare("SELECT * FROM units WHERE active=1").all<UnitRow>();
  const q = norm(name).replace(/^юнит\s+/, "");
  return units.results.find(u => {
    const n = norm(u.name);
    return n === norm(name) || n.replace(/^юнит\s+/, "") === q || n.includes(q) || q.includes(n.replace(/^юнит\s+/, ""));
  }) || null;
}

function employeeLink(e: EmployeeRow, env: Env): string | null {
  const username = (env.BOT_USERNAME || "").replace(/^@/, "").trim();
  if (!username || username === "CHANGE_ME_WITHOUT_AT") return null;
  return `https://t.me/${username}?start=link_${e.invite_code}`;
}

function parseBirthday(input: string): { mmdd: string; year: number | null } | null {
  const m = input.trim().match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{4}))?$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3] ? Number(m[3]) : null;
  if (!validDayMonth(day, month)) return null;
  if (year && (year < 1900 || year > new Date().getUTCFullYear())) return null;
  return { mmdd: `${pad(month)}-${pad(day)}`, year };
}

function parseBirthdayNatural(input: string): { mmdd: string; year: number | null } | null {
  const direct = parseBirthday(input);
  if (direct) return direct;
  const months: Record<string, number> = {
    января: 1, январь: 1, февраля: 2, февраль: 2, марта: 3, март: 3, апреля: 4, апрель: 4,
    мая: 5, май: 5, июня: 6, июнь: 6, июля: 7, июль: 7, августа: 8, август: 8,
    сентября: 9, сентябрь: 9, октября: 10, октябрь: 10, ноября: 11, ноябрь: 11, декабря: 12, декабрь: 12,
  };
  const m = norm(input).match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?/i);
  if (!m) return null;
  const day = Number(m[1]);
  const month = months[m[2]];
  const year = m[3] ? Number(m[3]) : null;
  if (!month || !validDayMonth(day, month)) return null;
  return { mmdd: `${pad(month)}-${pad(day)}`, year };
}

function validDayMonth(day: number, month: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(2000, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function daysUntilBirthday(mmdd: string, todayYmd: string): number {
  const [year, month, day] = todayYmd.split("-").map(Number);
  const [m, d] = mmdd.split("-").map(Number);
  let target = safeBirthdayDate(year, m, d);
  const today = Date.UTC(year, month - 1, day);
  if (target < today) target = safeBirthdayDate(year + 1, m, d);
  return Math.round((target - today) / 86400000);
}

function nextBirthdayDate(mmdd: string, todayYmd: string): string {
  const [year, month, day] = todayYmd.split("-").map(Number);
  const [m, d] = mmdd.split("-").map(Number);
  const today = Date.UTC(year, month - 1, day);
  let y = year;
  let target = safeBirthdayDate(y, m, d);
  if (target < today) { y++; target = safeBirthdayDate(y, m, d); }
  const dt = new Date(target);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function safeBirthdayDate(year: number, month: number, day: number): number {
  if (month === 2 && day === 29 && !isLeap(year)) return Date.UTC(year, 1, 28);
  return Date.UTC(year, month - 1, day);
}

function isLeap(y: number): boolean { return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); }

function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value || "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

function localDateString(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function fmtMmdd(mmdd: string): string {
  const [m, d] = mmdd.split("-");
  return `${d}.${m}`;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
function norm(s: string): string { return s.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " "); }
function dashNull(s: string): string | null { const t = s.trim(); return !t || t === "-" ? null : t; }
function normalizeUsername(s: string): string | null { const t = s.trim().replace(/^@/, ""); return !t || t === "-" ? null : t; }
function safeJson(s: string): Record<string, any> { try { return JSON.parse(s); } catch { return {}; } }
function randomCode(): string { return crypto.randomUUID().replace(/-/g, "").slice(0, 16); }
function esc(s: string): string { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function htmlEsc(s: string): string { return esc(s).replace(/"/g, "&quot;"); }
function keyboard(rows: InlineButton[][]): InlineMarkup { return { inline_keyboard: rows }; }

async function webhookSecret(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(`nectarin-webhook:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function ensureTelegramWebhook(env: Env, webhookUrl: string): Promise<void> {
  const secret = await webhookSecret(env.TELEGRAM_BOT_TOKEN);
  await tgCall(env, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
}

async function tgSend(env: Env, chatId: number, text: string, replyMarkup?: InlineMarkup): Promise<any> {
  return tgCall(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}

async function tgDelete(env: Env, chatId: number, messageId: number): Promise<any> {
  return tgCall(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

async function tgAnswerCb(env: Env, callbackQueryId: string, text: string): Promise<any> {
  return tgCall(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

async function tgCall(env: Env, method: string, payload: Record<string, unknown>): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json() as { ok: boolean; description?: string; result?: unknown };
  if (!r.ok || !j.ok) throw new Error(`Telegram ${method}: ${j.description || r.statusText}`);
  return j.result;
}

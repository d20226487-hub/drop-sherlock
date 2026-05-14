import Link from "next/link";

export const metadata = { title: "Настройки — Drop Sherlock" };

export default function SettingsDoc() {
  return (
    <div className="docs-content">
      <h1>Настройки</h1>
      <p>
        Страница <code>/settings</code> разделена на пять вкладок:{" "}
        <strong>API</strong>, <strong>Brain</strong>,{" "}
        <strong>Wayback</strong>, <strong>Domain availability</strong>{" "}
        и <strong>Other</strong>. Здесь вы храните ключи провайдеров,
        тюните «мозг» (промпты + scoring), настраиваете
        Wayback-классификацию, конфигурируете каскад проверки
        доступности доменов и админите хранение / backups.
      </p>

      <h2>Вкладка «API»</h2>
      <p>В этой вкладке две секции:</p>
      <ul>
        <li>
          <strong>Providers</strong> — список провайдеров ИИ
          (OpenAI / Anthropic / Gemini / OpenRouter / DeepSeek / Vertex
          AI и т.&nbsp;д.) и поле для ключа каждого. Также — Ahrefs API
          token, который нужен для всех Ahrefs-критериев. Включённые
          провайдеры появляются в выпадающих списках на странице{" "}
          <Link href="/docs/analyze">Анализа</Link> и в селекторах
          переоценки.
        </li>
        <li>
          <strong>Pricing</strong> — таблица «провайдер × модель → цена за
          1M input/output токенов». Drop Sherlock считает стоимость
          вызова на лету по этой таблице. Цены фиксируются на момент
          вызова — поздние редакты не пересчитывают исторические данные.
        </li>
      </ul>
      <p>
        Полная статья — <Link href="/docs/ai">«ИИ: провайдеры, модели,
        стоимость»</Link>.
      </p>

      <div className="callout callout-info docs-content">
        <p>
          <strong>Шифрование секретов:</strong> ключи провайдеров и
          доступы S3 хранятся в БД в зашифрованном виде (Fernet). Ключ
          шифрования берётся из <code>FERNET_KEYS</code> в{" "}
          <code>.env</code>; если переменная пуста — генерируется при
          первом запуске и складывается в <code>/data/.fernet_key</code>{" "}
          (тот же том, что и БД). При экспорте БД через S3-бэкап (см.
          ниже) выгружается только <code>.db</code>, ключ шифрования{" "}
          <em>не</em> попадает в облако — это и есть та защита, ради
          которой шифрование добавлено: украденный бэкап без ключа
          нечитаем.
        </p>
      </div>

      <h2>Вкладка «Brain»</h2>
      <p>
        «Мозг» инструмента. Две секции:
      </p>
      <ul>
        <li>
          <strong>Scoring</strong> — веса критериев и пороги бакетов
          (good / mixed / low_quality), плюс low_confidence_threshold.
        </li>
        <li>
          <strong>Prompts</strong> — системные промпты для каждого
          ИИ-судьи + finale + директива русского вывода. Полностью
          редактируемы; reset возвращает к дефолту.
        </li>
      </ul>
      <p>
        Полная статья — <Link href="/docs/brain">«Brain — Scoring и
        Prompts»</Link>.
      </p>

      <h2>Вкладка «Wayback»</h2>
      <p>
        Конфигурация Wayback Classify (language + theme + category).
        Управляет:
      </p>
      <ul>
        <li>
          <strong>Language mode</strong> — определять язык через ИИ-промпт
          (combined) или через детерминированную библиотеку lingua
          (theme_only режим, в нём ИИ оценивает только тематику, язык —
          из библиотеки).
        </li>
        <li>
          <strong>Categories</strong> — ваш список пользовательских
          категорий с описаниями. По этому списку ИИ-судья выбирает один
          вариант на домен.
        </li>
      </ul>
      <p>
        Полная статья — <Link href="/docs/wayback-classify">«Wayback
        Classify»</Link>.
      </p>

      <h2>Вкладка «Domain availability»</h2>
      <p>
        Конфигурация каскада проверки доступности доменов (опт-ин с
        формы <Link href="/docs/analyze">Анализа</Link>). Управляет:
      </p>
      <ul>
        <li>
          <strong>Providers</strong> — список включённых провайдеров
          каскада: DNS / RDAP / Domainr / WHOIS. Каждый можно
          отдельно отключить.
        </li>
        <li>
          <strong>Cascade order</strong> — drag-reorderable порядок,
          в котором провайдеры опрашиваются. Каскад останавливается на
          первом терминальном ответе (available / registered).
        </li>
        <li>
          <strong>Rate limits</strong> — RPS и max-concurrent на
          провайдера. Жёсткий потолок 10 req/sec независимо от
          введённого значения (clamps на запись).
        </li>
        <li>
          <strong>Domainr API key</strong> — ключ RapidAPI для платной
          подстраховки (free Basic tier даёт 10k lookups/мес).
          Хранится зашифрованным.
        </li>
        <li>
          <strong>Cache TTL</strong> — окно, в течение которого
          terminal-результат переиспользуется без повторных запросов
          (по умолчанию 24 ч).
        </li>
        <li>
          <strong>Skip-registered policy</strong> — горизонт «не
          трогать зарегистрированные домены, истекающие позже чем
          через N дней». Экономит юниты на больших списках, где много
          явно «живых» доменов.
        </li>
        <li>
          <strong>Recent-checks retention</strong> — добавлено
          2026-05-14. Два совмещающихся лимита для таблицы{" "}
          <code>availability_checks</code> (журнал каждого ответа
          провайдера): «retention days» (удалять старее N дней,
          по умолчанию 30, 0 = не чистить по возрасту) и «keep per
          domain» (после возрастной зачистки оставить M свежих
          записей на домен, по умолчанию 20, 0 = без лимита).
          Запускается ежедневно APScheduler и один раз при старте
          контейнера. Подробнее — в{" "}
          <Link href="/docs/backups">«Резервные копии»</Link>.
        </li>
        <li>
          <strong>Monthly usage</strong> + <strong>Recent log</strong>{" "}
          — таблицы для аудита: сколько проверок было в этом месяце
          по провайдерам, и последние 50 ответов с латентностью и
          ошибками.
        </li>
      </ul>

      <h2>Вкладка «Other»</h2>
      <p>Админские опции:</p>
      <ul>
        <li>
          <strong>Retention</strong> — сколько хранить старые задачи и
          журнал ошибок. По умолчанию — задано с запасом, чтобы база не
          росла бесконечно.
        </li>
        <li>
          <strong>Import limit</strong> — максимальный размер CSV-импорта
          в Очередь. Защищает от случайных огромных файлов.
        </li>
        <li>
          <strong>Backups</strong> — настройка локальных бекапов SQLite
          (с ротацией) + опциональная отправка на S3-совместимое
          хранилище. Подробности в{" "}
          <Link href="/docs/backups">отдельной статье</Link>.
        </li>
      </ul>

      <h3>VACUUM (API-only)</h3>
      <p>
        Добавлено 2026-05-14. Ежемесячный <code>VACUUM</code> для
        возврата пустых страниц на диск (после ретенций / bulk-delete).
        UI на странице Настроек пока нет — управление через
        endpoint-ы:
      </p>
      <ul>
        <li>
          <code>GET /settings/db-maintenance</code> — текущее
          состояние тумблера.
        </li>
        <li>
          <code>PUT /settings/db-maintenance/vacuum-enabled</code>{" "}
          с телом <code>{`{"enabled": true|false}`}</code> —
          включить / выключить ежемесячный cron (1-е число месяца,
          03:30 UTC). По умолчанию ВКЛ.
        </li>
        <li>
          <code>POST /settings/db-maintenance/vacuum-now</code> —
          ручной триггер с теми же защитными проверками (≥ 2×
          DB-size свободного места + shared maintenance lock с
          бэкапом).
        </li>
      </ul>
      <p>
        Полное описание режима + защитные проверки — в{" "}
        <Link href="/docs/backups">«Резервные копии»</Link>.
      </p>

      <h2>Где что менять — короткая шпаргалка</h2>
      <table>
        <thead>
          <tr>
            <th>Хочется...</th>
            <th>Идти в</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Добавить новый ИИ-ключ</td>
            <td>Settings → API → Providers</td>
          </tr>
          <tr>
            <td>Сменить цену модели</td>
            <td>Settings → API → Pricing</td>
          </tr>
          <tr>
            <td>Переписать промпт «как считать спам»</td>
            <td>Settings → Brain → Prompts</td>
          </tr>
          <tr>
            <td>Сдвинуть порог good ≥ 70 на ≥ 75</td>
            <td>Settings → Brain → Scoring</td>
          </tr>
          <tr>
            <td>Добавить категорию для классификации</td>
            <td>Settings → Wayback → Categories</td>
          </tr>
          <tr>
            <td>Включить проверку доступности в каскаде</td>
            <td>Settings → Domain availability → Providers</td>
          </tr>
          <tr>
            <td>Изменить, сколько хранить «недавние проверки»</td>
            <td>Settings → Domain availability → Recent-checks retention</td>
          </tr>
          <tr>
            <td>Включить выгрузку backups на S3</td>
            <td>Settings → Other → Backups</td>
          </tr>
          <tr>
            <td>Запустить VACUUM сейчас</td>
            <td>
              POST <code>/settings/db-maintenance/vacuum-now</code>{" "}
              (UI пока нет)
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

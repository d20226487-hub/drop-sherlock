import Link from "next/link";

export const metadata = { title: "CSV — Drop Sherlock" };

export default function CsvDoc() {
  return (
    <div className="docs-content">
      <h1>CSV: импорт и экспорт</h1>
      <p>
        Drop Sherlock работает с CSV в трёх местах: импорт в Очередь,
        экспорт из Очереди и экспорт из Базы. Эта статья — про форматы.
      </p>

      <h2>Импорт в Очередь</h2>
      <p>
        Кнопка <strong>«Импорт CSV»</strong> на странице{" "}
        <Link href="/docs/backlog">Очереди</Link>. Файл — стандартный CSV
        (запятые, опциональные кавычки). Заголовки колонок —{" "}
        <em>обязательны</em>, регистронезависимы.
      </p>
      <h3>Колонки</h3>
      <table>
        <thead>
          <tr>
            <th>Колонка</th>
            <th>Обязательна</th>
            <th>Описание</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>domain</code></td>
            <td>Да</td>
            <td>Нормализуется: убираются <code>https://</code>, <code>www.</code>, путь.</td>
          </tr>
          <tr>
            <td><code>registrar</code></td>
            <td>Нет</td>
            <td>Свободный текст, для фильтра.</td>
          </tr>
          <tr>
            <td><code>expiration_date</code></td>
            <td>Нет</td>
            <td>
              ISO <code>YYYY-MM-DD</code> или популярные форматы (<code>DD.MM.YYYY</code>,{" "}
              <code>MM/DD/YYYY</code>). Drop Sherlock пытается распарсить.
            </td>
          </tr>
          <tr>
            <td><code>desired_price</code></td>
            <td>Нет</td>
            <td>Число. Доллары, без символа.</td>
          </tr>
          <tr>
            <td><code>max_price</code></td>
            <td>Нет</td>
            <td>Число. Доллары, без символа.</td>
          </tr>
          <tr>
            <td><code>comments</code></td>
            <td>Нет</td>
            <td>Свободный текст. Можно многострочный (в кавычках).</td>
          </tr>
          <tr>
            <td><code>status</code></td>
            <td>Нет</td>
            <td>
              Если задан, должен быть одним из <code>backlog</code> /{" "}
              <code>in_progress</code> / <code>analyzed</code> /{" "}
              <code>order</code> / <code>backordered</code> /{" "}
              <code>bought</code> / <code>discarded</code>. По умолчанию —{" "}
              <code>backlog</code>.
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Поведение импорта</h3>
      <ul>
        <li>
          <strong>Дедупликация по домену.</strong> Если домен уже есть в
          Очереди, повторная загрузка <em>обновляет</em> его поля (а не
          создаёт второй строки). Это позволяет лить ежедневный свежий
          выгруз с биржи поверх существующего.
        </li>
        <li>
          <strong>Пустые ячейки</strong> не затирают существующие
          значения. Если в CSV нет колонки <code>desired_price</code>, а
          раньше вы её редактировали в UI — она останется.
        </li>
        <li>
          <strong>Невалидные домены</strong> (без точки, с пробелами и
          т.&nbsp;п.) пропускаются с предупреждением.
        </li>
      </ul>
      <h3>Лимит размера</h3>
      <p>
        Максимальный размер файла задаётся в{" "}
        <Link href="/docs/settings">Настройках</Link> → «Other» → «Import
        limit». По умолчанию задано с запасом. Защищает от случайных
        огромных файлов.
      </p>

      <h2>Экспорт из Очереди</h2>
      <p>В шапке Очереди две кнопки:</p>
      <ul>
        <li>
          <strong>Экспорт отфильтрованных (N)</strong> — только то, что
          сейчас под фильтром.
        </li>
        <li>
          <strong>Экспорт всех (N)</strong> — вся Очередь, игнорируя
          фильтры.
        </li>
      </ul>
      <p>
        Файл скачивается потоком — браузер не держит весь CSV в памяти.
      </p>
      <h3>Колонки экспорта</h3>
      <p>
        Те же, что в импорте, плюс <code>created_at</code> и{" "}
        <code>updated_at</code> (ISO 8601 с миллисекундами). Если вы
        используете экспорт как «бэкап», его можно потом импортировать
        обратно — Drop Sherlock игнорирует timestamps на входе (они
        пересчитываются).
      </p>

      <h2>Экспорт из Базы</h2>
      <p>
        Кнопка <strong>«Export CSV»</strong> на странице{" "}
        <Link href="/docs/database">Базы</Link>. Экспортируется{" "}
        <em>отфильтрованная</em> выборка.
      </p>
      <h3>Колонки</h3>
      <ul>
        <li><code>domain</code></li>
        <li><code>is_pinned</code> — <code>true</code> / <code>false</code>.</li>
        <li><code>pinned_run_id</code>, <code>pinned_run_name</code> — какой запуск канонический.</li>
        <li><code>partial</code> — <code>true</code>, если final был partial.</li>
        <li><code>score</code>, <code>bucket</code>, <code>confidence</code>.</li>
        <li><code>ai_provider</code>, <code>ai_model</code>.</li>
        <li><code>wayback_verdict</code>, <code>wayback_confidence</code>.</li>
        <li><code>primary_language</code>, <code>secondary_languages</code> (объединены через <code>|</code>).</li>
        <li><code>primary_theme</code>, <code>secondary_themes</code>.</li>
        <li><code>category</code>, <code>category_confidence</code>, <code>category_was</code>.</li>
        <li><code>backlinks_rows</code>, <code>refdomains_rows</code>, <code>anchors_rows</code>, <code>keywords_rows</code>.</li>
        <li><code>note</code>.</li>
        <li><code>backlog_status</code>.</li>
      </ul>
      <p>
        Удобно открывать в Excel/Sheets для пакетных решений и
        отправки клиентам/коллегам.
      </p>

      <h2>Round-trip</h2>
      <p>
        Экспорт из Очереди → импорт в другую инсталляцию Drop Sherlock
        работает «как есть»: вы получите ту же Очередь с теми же
        статусами/ценами. Это удобно для миграции данных между
        окружениями.
      </p>
    </div>
  );
}

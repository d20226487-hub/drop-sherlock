import Link from "next/link";

export const metadata = { title: "Настройки — Drop Sherlock" };

export default function SettingsDoc() {
  return (
    <div className="docs-content">
      <h1>Настройки</h1>
      <p>
        Страница <code>/settings</code> разделена на четыре вкладки. Здесь
        вы храните ключи провайдеров, тюните «мозг» (промпты + scoring),
        настраиваете Wayback-классификацию и админите хранение / backups.
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
            <td>Включить выгрузку backups на S3</td>
            <td>Settings → Other → Backups</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

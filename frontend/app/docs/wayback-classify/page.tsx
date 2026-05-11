import Link from "next/link";

export const metadata = { title: "Wayback Classify — Drop Sherlock" };

export default function WaybackClassifyDoc() {
  return (
    <div className="docs-content">
      <h1>Wayback Classify</h1>
      <p>
        Wayback Classify — отдельный критерий, который из архивных
        снепшотов Wayback Machine определяет <strong>язык</strong> и{" "}
        <strong>тематику</strong> домена, а затем сопоставляет тематику с
        одной из ваших пользовательских <strong>категорий</strong>. Это
        ключевая фича для подбора доноров под конкретный проект: «доно в
        тематике real estate, на русском» — фильтруется в Базе тремя
        галочками.
      </p>

      <h2>Чем отличается от обычного wayback-вердикта</h2>
      <p>
        Обычный <code>wayback</code>-судья отвечает на вопрос «насколько
        история домена качественная» — он смотрит распределение
        statuscode, длину истории, тематический дрифт как red flag.
        <code>wayback_classify</code> — это <em>не</em> оценка качества, а
        классификация: «о чём этот сайт был? на каком языке?». Они
        дополняют друг друга.
      </p>

      <h2>Этапы</h2>
      <p>Wayback Classify работает в две стадии:</p>
      <ol>
        <li>
          <strong>Theme + Language detection</strong> — ИИ-вызов
          возвращает <code>primary_theme</code>,{" "}
          <code>secondary_themes</code>, <code>primary_language</code>,{" "}
          <code>drift_detected</code>, опционально историю смены тем.
        </li>
        <li>
          <strong>Category mapping</strong> — отдельный ИИ-вызов,
          получающий результат шага 1 + ваш список категорий, и
          возвращающий одну категорию по имени (либо <code>other</code>,
          если ничего не подошло).
        </li>
      </ol>

      <h2>Language mode: AI vs Library</h2>
      <p>
        В <Link href="/docs/settings">Настройках</Link> → «Wayback» можно
        выбрать, как определять язык:
      </p>
      <ul>
        <li>
          <strong>AI</strong> (по умолчанию) — один ИИ-промпт{" "}
          <code>wayback_classify_combined</code> возвращает и тему, и
          язык. Быстро, но язык может «гулять» на коротких текстах с
          нелатинскими алфавитами.
        </li>
        <li>
          <strong>Library</strong> — детерминированная библиотека{" "}
          <code>lingua-language-detector</code> агрегирует язык из
          текстов сэмплов. ИИ при этом отвечает только за тему
          (промпт <code>wayback_classify_theme_only</code>). Стабильнее на
          коротких/смешанных текстах; теряет нюансы, которые ИИ мог бы
          подсмотреть из контекста.
        </li>
      </ul>
      <p>
        В обоих режимах язык в выводе — ISO 639-1 lowercase (
        <code>en</code>, <code>ru</code>, <code>kk</code>, <code>zh</code>{" "}
        и т.&nbsp;д.). Это нужно, чтобы фильтр в Базе работал на едином
        значении.
      </p>

      <h2>Drift detection</h2>
      <p>
        ИИ-судья отличает два разных сценария «несколько тем»:
      </p>
      <ul>
        <li>
          <strong>Multi-topic</strong> — сайт всегда писал и про кулинарию,
          и про путешествия. Это <em>не</em> дрифт; primary_theme — одно,
          secondary_themes — остальное, <code>drift_detected = false</code>.
        </li>
        <li>
          <strong>Sequential drift</strong> — раньше был каталог
          парикмахерских, потом стал казино-обзоры. Это{" "}
          <em>дрифт</em>; <code>drift_detected = true</code>,{" "}
          <code>primary_theme</code> = самая свежая,{" "}
          <code>history</code> содержит хронологию.
        </li>
      </ul>
      <p>
        Дрифт критичен для drop-hunter: домен с дрифтом на казино, скорее
        всего, уже отдал свой PageRank новой площадке и не подходит под
        белый линкбилдинг.
      </p>

      <h2>Категории</h2>
      <p>
        Список категорий редактируется в Настройках → «Wayback» →
        «Categories». Каждая запись — имя + описание. Описание важно: ИИ
        принимает решение «семантически», читая описание, а не угадывая по
        имени.
      </p>
      <p>Пример вашего списка категорий:</p>
      <pre><code>{`real_estate    — каталоги недвижимости, агентства, ЖК
finance        — кредиты, банки, инвестиции
ecommerce      — интернет-магазины широкого ассортимента
local_services — клиники, СТО, ремонтные мастерские
news_blog      — новости, авторские блоги, медиа
casino_spam    — гемблинг, ставки, чёрные ниши (для red flag)`}</code></pre>
      <p>
        Если ничего не подходит, ИИ выводит <code>other</code>. Это{" "}
        <em>осознанный выбор</em>, а не «давайте напихаем плохо подходящее».
      </p>

      <h3>category_was — для drift-доменов</h3>
      <p>
        Если <code>drift_detected = true</code>, у вердикта появится
        дополнительное поле <code>category_was</code> — категория{" "}
        <em>прошлого</em> состояния домена. Это помогает увидеть «был
        food-blog, стал casino» одним глазом, не открывая историю.
      </p>

      <h2>Что видно в UI</h2>
      <ul>
        <li>
          В <Link href="/docs/database">Базе</Link> — колонки Language,
          Theme, Category. Фильтры в шапке.
        </li>
        <li>
          В{" "}
          <Link href="/docs/domain">странице домена</Link>, вкладка
          Wayback Classify — структурированный вид: language секция,
          themes, drift-история, category + reasoning.
        </li>
        <li>
          Confidence scores на каждом поле, как и у других ИИ-судей.
        </li>
      </ul>

      <h2>Кэш и Wayback Classify</h2>
      <p>
        Промпты <code>wayback_classify_combined</code>,{" "}
        <code>wayback_classify_theme_only</code>,{" "}
        <code>wayback_category</code> кэшируются как обычные ИИ-вердикты
        (см. <Link href="/docs/cache">«Кэш»</Link>). Категория-список
        входит в хеш user-message — если вы добавили новую категорию, кэш
        category-step промахнётся (а theme-step может остаться в кэше — он
        список категорий не видит).
      </p>
    </div>
  );
}

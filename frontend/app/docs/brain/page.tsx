import Link from "next/link";

export const metadata = { title: "Brain — Drop Sherlock" };

export default function BrainDoc() {
  return (
    <div className="docs-content">
      <h1>Brain — Scoring и Prompts</h1>
      <p>
        «Мозг» инструмента — это то, как сырые данные из Ahrefs превращаются
        в вердикт «брать или не брать». Состоит из двух частей: набор
        системных промптов для ИИ-судей и детерминированная математика, по
        которой их вердикты собираются в финальный балл.
      </p>
      <p>
        Открывается в <Link href="/docs/settings">Настройках</Link> → «Brain».
        Здесь же редактируются.
      </p>

      <h2>Архитектура</h2>
      <p>
        Drop Sherlock сознательно <em>не</em> доверяет ИИ финальную
        арифметику — большие модели плохо считают и постоянно «гуляют»
        между прогонами. Поэтому процесс разделён на две стадии:
      </p>
      <ol>
        <li>
          <strong>Per-criterion judges</strong> — четыре ИИ-судьи
          (backlinks, refdomains, anchors, keywords) + wayback judge. Каждый
          получает свой кусок данных и возвращает{" "}
          <code>assessment</code> (high/mixed/low) + <code>confidence</code>{" "}
          (0..1) + key_findings + red_flags. Ничего, кроме своего
          критерия.
        </li>
        <li>
          <strong>Final score</strong> — посчитан кодом (<code>scoring.py</code>),
          не ИИ. Веса по критериям + пороги бакетов задаются в Настройках.
        </li>
        <li>
          <strong>Final synth</strong> — отдельный ИИ-вызов, который видит
          все sub-verdicts и пишет короткое объяснение (summary +
          recommendation). Балл и confidence в финал передаются из шага 2,
          их ИИ <em>не пересчитывает</em>.
        </li>
      </ol>

      <h2>Scoring</h2>
      <p>В секции Scoring настройки:</p>
      <ul>
        <li>
          <strong>Веса по критериям</strong>: <code>backlinks</code>,{" "}
          <code>refdomains</code>, <code>anchors</code>,{" "}
          <code>keywords</code>. Каждый — число от 0 до 1. Веса
          нормализуются автоматически: если какой-то критерий не сработал
          (failed / disabled), его вес перераспределяется на оставшиеся —
          вы не получите искусственно заниженный балл, потому что один
          критерий выпал.
        </li>
        <li>
          <strong>Бакеты:</strong> <code>good_threshold</code> и{" "}
          <code>mixed_threshold</code>. Логика: если итоговый балл ≥
          good_threshold — bucket = good; иначе если ≥ mixed_threshold —
          mixed; иначе low_quality.
        </li>
        <li>
          <strong>low_confidence_threshold</strong> — если средняя
          confidence судей ниже этого значения, бакет визуально подсвечен
          серым (предупреждение «уверенность низкая, не доверяйте слепо»).
        </li>
      </ul>
      <p>
        Финальный балл считается из <code>assessment</code> и{" "}
        <code>confidence</code> каждого критерия:
      </p>
      <pre><code>{`final_score = sum(weight_i * assess_score_i * confidence_i)
            / sum(weight_i * confidence_i)

assess_score: high_quality → 100, mixed → 60, low_quality → 20`}</code></pre>
      <p>
        Формула считается только над теми критериями, которые отработали.
        Вердикты wayback и wayback_classify <em>не входят в final score</em> —
        они хранятся отдельно и видны в Базе/Domain как самостоятельные
        колонки. Идея: историю смотрите глазами, не сводите её к одному
        числу.
      </p>

      <h2>Стоп-слова</h2>
      <p>
        Секция <strong>Стоп-слова</strong> хранит один общий на воркспейс
        словарь «испорченных ниш» — гемблинг, adult, фарма, займы,
        реплики и всё остальное, что вы не покупаете. Его использует
        критерий <strong>S — Stop words</strong>: он просит у Ahrefs
        только те анкоры и органические ключи, которые{" "}
        <em>содержат</em> одно из этих слов, а ИИ затем оценивает степень
        загрязнения домена (подробнее — в статье{" "}
        <Link href="/docs/ahrefs-criteria">«Ahrefs-критерии»</Link>).
      </p>
      <ul>
        <li>
          Совпадение — <strong>подстрока без учёта регистра</strong>.
          «casino» ловит «casinos» и «onlinecasino», но также безобидное
          «specialist» для «cialis»; промпт судьи отдельно инструктирован
          отбрасывать такие ложные срабатывания.
        </li>
        <li>
          Фразы из нескольких слов допустимы («free spins»). Длина слова
          на стоимость и лимиты не влияет.
        </li>
        <li>
          Список <strong>замораживается в спеке запуска</strong> при
          отправке задачи. Поздняя правка не переписывает уже завершённые
          запуски; повторный запуск (rerun) подхватывает актуальный
          список, а <Link href="/docs/cache">кэш</Link> учитывает слова в
          хэше параметров — сменился список, данные перезапрашиваются.
        </li>
        <li>
          Ahrefs не принимает больше 255 условий в одном фильтре. Список
          длиннее 250 слов разбивается на несколько запросов, каждый
          оплачивается отдельно — интерфейс предупреждает об этом.
        </li>
      </ul>

      <h2>Prompts</h2>
      <p>
        В секции Prompts — 11 редактируемых системных промптов:
      </p>
      <ul>
        <li>
          <strong>backlinks / refdomains / anchors / keywords</strong> —
          судьи по соответствующим Ahrefs-критериям. Какие именно сигналы
          они оценивают, описано в статье{" "}
          <Link href="/docs/ahrefs-criteria">«Ahrefs-критерии»</Link>.
        </li>
        <li>
          <strong>stop_words</strong> — судья по стоп-словам. Полярность
          перевёрнута: в выдаче нет «хороших» строк, поэтому он оценивает
          не качество, а степень загрязнения, и{" "}
          <code>high_quality</code> здесь означает «чисто».
        </li>
        <li>
          <strong>wayback</strong> — судья по истории через CDX + V2.
        </li>
        <li>
          <strong>wayback_classify_combined</strong> — один промпт, который
          одновременно определяет язык и тематику (используется в режиме
          Language Mode = AI).
        </li>
        <li>
          <strong>wayback_classify_theme_only</strong> — только тематика
          (используется, когда язык определяет lingua-библиотека).
        </li>
        <li>
          <strong>wayback_category</strong> — маппит тематику в одну из
          ваших категорий.
        </li>
        <li>
          <strong>final</strong> — синтезатор финального summary.
        </li>
        <li>
          <strong>localize_ru</strong> — директива «отвечай по-русски»,
          которая добавляется в конец любого промпта на RU-запусках.
          Подробности ниже.
        </li>
      </ul>
      <p>
        У каждого промпта плашка <code>Default</code> или <code>Customized</code>{" "}
        в зависимости от того, есть ли DB-override. «Reset to default»
        стирает override.
      </p>

      <h3>Структура промпта</h3>
      <p>
        Все per-criterion промпты строятся по одной схеме:
      </p>
      <ol>
        <li>
          <strong>Роль</strong> — «You are an SEO analyst evaluating ...».
        </li>
        <li>
          <strong>Что входит на вход</strong> — какие поля Ahrefs придут.
        </li>
        <li>
          <strong>Правила оценки</strong> — приоритеты: что считать high
          quality, что low.
        </li>
        <li>
          <strong>Output schema</strong> — обязательный JSON-формат с
          enum-полем assessment.
        </li>
      </ol>
      <p>
        Если вы редактируете промпт, сохраняйте обязательный JSON-блок в
        конце — иначе парсер ответа упадёт и вердикт пометится failed.
      </p>

      <h3>localize_ru — директива русского вывода</h3>
      <p>
        Базовые промпты хранятся на английском. На RU-запусках Drop
        Sherlock <em>дописывает в конец</em> текст из{" "}
        <code>localize_ru</code> — это и есть «отвечай по-русски в
        свободных полях». Не переводит enum-поля (assessment), не трогает
        ISO-коды языков, имена категорий — всё это явно перечислено как
        исключения.
      </p>
      <p>
        Зачем так:
      </p>
      <ul>
        <li>
          Вы поддерживаете один промпт на критерий, а не два. Поменять
          логику оценки нужно в одном месте.
        </li>
        <li>
          Хеш промпта (используется в кэше) разный на EN и RU — вердикты
          не смешиваются.
        </li>
        <li>
          Если ИИ-модель плохо реагирует на trailing-директиву (у нас
          такое было с Gemini Flash на коротких промптах), вы можете
          подкрутить тон директивы прямо в Настройках, не лезть в код.
        </li>
      </ul>
      <p>
        Слабее всего директива работает, когда основной промпт сильно
        больше неё (≥ 2000 слов английского текста vs 200 слов RU).
        В таких случаях рассмотрите вариант перевести соответствующий
        per-criterion промпт целиком (override на RU-инсталляции).
      </p>

      <h2>Как тюнить</h2>
      <p>Типовые задачи:</p>
      <ul>
        <li>
          <strong>«Хочу строже к спам-сети»</strong> — отредактируйте{" "}
          <code>backlinks</code> или <code>refdomains</code>, усильте
          секцию rules: «'low_quality' if more than 30% of sources have DR
          {" "}&gt;{" "}50 but positions &lt; 5» (для backlinks) или «{" "}
          traffic_domain &lt; 100» (для refdomains).
        </li>
        <li>
          <strong>«Хочу мягче к молодым доменам»</strong> — сдвиньте порог
          в Scoring: уменьшите <code>good_threshold</code> с 70 до 65.
        </li>
        <li>
          <strong>«Backlinks важнее всего, остальное —
          контекст»</strong> — увеличьте <code>backlinks</code>-вес до
          0.5, остальные — по 0.17.
        </li>
        <li>
          <strong>«Хочу узнавать о low confidence громче»</strong> —
          увеличьте <code>low_confidence_threshold</code> с 0.5 до 0.6 —
          больше доменов будут визуально подсвечены серым.
        </li>
      </ul>

      <div className="callout callout-warn docs-content">
        <p>
          <strong>Внимание:</strong> правка промпта инвалидирует кэш по
          этому критерию — все новые запуски пойдут в ИИ заново. Это{" "}
          <em>специально</em>: вы поменяли правила, старые вердикты больше
          не отражают вашу логику. Ahrefs-данные при этом не
          перекачиваются (хеш параметров запроса не зависит от промпта).
        </p>
      </div>
    </div>
  );
}

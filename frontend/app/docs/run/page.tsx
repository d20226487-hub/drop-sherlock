import Link from "next/link";

export const metadata = { title: "Страница запуска — Drop Sherlock" };

export default function RunDoc() {
  return (
    <div className="docs-content">
      <h1>Страница запуска</h1>
      <p>
        Открывается из <Link href="/docs/jobs">страницы Задачи</Link>,
        кликом по строке нужного Run. Это «диспетчерская»: видно прогресс
        по каждому домену, можно ставить паузу, переоценивать, закреплять
        домены в Базу.
      </p>

      <h2>Шапка</h2>
      <ul>
        <li>Имя запуска (Run #N, если не присвоено).</li>
        <li>Статусная плашка: <code>pending / running / paused / done / failed / canceled</code>.</li>
        <li>
          Прогресс: число доменов <code>done / total</code> и сколько с
          ошибкой.
        </li>
        <li>
          Стоимость (юниты Ahrefs + $ на ИИ) — суммарно по запуску.
        </li>
        <li>
          Кнопки управления: Pause / Resume / Cancel / Rename / Retry failed /
          Reanalyze. Кнопка «Pin entire run» удалена в 2026-05-12; её
          функцию выполняет панель «Per-criterion pins» под таблицей
          (см. ниже).
        </li>
      </ul>

      <h2>Таблица доменов</h2>
      <p>В каждом ряду:</p>
      <ul>
        <li>
          <strong>Domain</strong> — клик ведёт на{" "}
          <Link href="/docs/domain">страницу домена</Link> (полный разбор).
        </li>
        <li>
          <strong>Status</strong> — состояние домена внутри запуска
          (pending / running / done / failed).
        </li>
        <li>
          <strong>Criteria</strong> — пилюли{" "}
          <code>B&nbsp;D&nbsp;A&nbsp;K&nbsp;W&nbsp;C</code>. Это статус{" "}
          <em>сбора данных</em> по каждому критерию (зелёный = done, синий =
          running, красный = failed). Что означает каждая буква:
          <ul>
            <li>
              <code>B</code> — <strong>Backlinks</strong> (входящие ссылки)
            </li>
            <li>
              <code>D</code> — <strong>refDomains</strong> (ссылающиеся
              домены)
            </li>
            <li>
              <code>A</code> — <strong>Anchors</strong> (анкоры)
            </li>
            <li>
              <code>K</code> — <strong>Keywords</strong> (органические
              ключи)
            </li>
            <li>
              <code>W</code> — <strong>Wayback</strong> (история в архиве)
            </li>
            <li>
              <code>C</code> — wayback_<strong>C</strong>lassify (язык +
              тематика + категория)
            </li>
          </ul>
          Глубокий разбор первых четырёх — в статье{" "}
          <Link href="/docs/ahrefs-criteria">«Ahrefs-критерии»</Link>; про
          C — в{" "}
          <Link href="/docs/wayback-classify">«Wayback Classify»</Link>.
        </li>
        <li>
          <strong>AI Ahrefs</strong> — пилюли{" "}
          <code>B&nbsp;D&nbsp;A&nbsp;K</code> (только четыре Ahrefs-критерия,
          те же буквы что выше). Это статус{" "}
          <em>ИИ-вердиктов</em> (зелёный = вердикт получен, красный = ИИ
          упал, серый = ещё не дошли).
        </li>
        <li>
          <strong>Verdict</strong> — итоговый bucket (good / mixed /
          low_quality / partial / no_verdict) + score, как только final
          assessment просчитан.
        </li>
        <li>
          <strong>AI</strong> — провайдер и модель, фактически выдавшие
          вердикт (после reanalyze может отличаться от spec.ai).
        </li>
        <li>
          <strong>Cost</strong> — стоимость по домену (юниты + $).
        </li>
        <li>
          <strong>Language / Theme / Category</strong> — выходы
          wayback_classify (для домена, у которого этот критерий
          включён). Подсвечивает дрейф темы (когда AI заметил, что
          текущая тема отличается от исторической).
        </li>
      </ul>
      <p>
        Закрепление в Базу теперь делается на уровне (Job, критерий) — не
        на уровне отдельного RunDomain. См. секцию «Per-criterion pins»
        ниже и статью <Link href="/docs/pinning">«Закрепление»</Link>.
      </p>

      <div className="callout callout-info docs-content">
        <p>
          <strong>Подсказка:</strong> чтобы быстро понять, упал ли какой-то
          критерий, смотрите на цветную пилюлю в <code>Criteria</code>{" "}
          (сбор) или <code>AI Ahrefs</code> (вердикт). Красный — нужно
          лечить. Полный текст ошибки виден на странице домена в
          соответствующей плашке.
        </p>
      </div>

      <h2>Retry failed</h2>
      <p>
        Кнопка в шапке. Drop Sherlock пройдётся по всем доменам, у которых
        есть упавшие критерии (либо в сборе данных, либо в ИИ), и попробует
        доделать только их. Удачные критерии не трогаются — токены и юниты
        не тратятся повторно.
      </p>
      <p>
        Типичные причины упавших критериев: rate limit Ahrefs, временный
        500 от ИИ-провайдера, обрыв соединения. Все они уходят после паузы
        и retry.
      </p>

      <h2>Reanalyze</h2>
      <p>
        Кнопка <strong>«Reanalyze with AI»</strong> заново вызывает
        ИИ-судью по всем доменам запуска — без перекачивания Ahrefs-данных.
        Полезно, если вы поменяли промпт в{" "}
        <Link href="/docs/brain">Brain</Link> и хотите увидеть новые
        вердикты на той же фактической базе.
      </p>
      <p>
        Reanalyze поддерживает выбор провайдера/модели — можно прогнать
        тот же набор данных через другую модель. Подробности в статье{" "}
        <Link href="/docs/reanalyze">«Переоценка»</Link>.
      </p>

      <h2>Per-criterion pins (панель под таблицей)</h2>
      <p>
        Заменила удалённую кнопку «Pin entire run» в 2026-05-12.
        Сворачиваемая панель с шестью карточками — по одной на каждый
        критерий, по которому у этого запуска есть данные{" "}
        (<code>B&nbsp;D&nbsp;A&nbsp;K&nbsp;W&nbsp;C</code>). Клик по
        карточке закрепляет критерий на этот Run в пределах Задачи
        (запись в таблицу <code>job_criterion_pins</code>); повторный
        клик — снимает пин.
      </p>
      <p>
        Кнопка <strong>«Pin all populated»</strong> внутри панели
        закрепляет одним движением все шесть критериев на этот Run.
        Удобно после полного успешного прогона, когда хочется сделать
        этот запуск эталоном для всех колонок Базы. На бейдже в шапке
        панели всегда видно «N/6 закреплено здесь» — даже когда панель
        свёрнута, это первый признак того, что Run уже частично канонический.
      </p>
      <p>
        Подробнее про разные уровни пинов и какой когда нужен — статья{" "}
        <Link href="/docs/pinning">«Закрепление»</Link>. Кросс-обзор «B
        ← Run #77, W ← Run #61, …» доступен на странице Задачи (новый
        read-only виджет, см.{" "}
        <Link href="/docs/jobs">«Задачи»</Link>).
      </p>

      <h2>Score Weights (свёрнуто по умолчанию)</h2>
      <p>
        Появилась в 2026-05-13. Сворачиваемая панель над таблицей —
        переопределяет глобальные веса критериев в Настройках для
        этого конкретного Run. Шесть полей B/D/A/K/W/C должны
        суммироваться до 1.0; галочка «exclude» обнуляет вес критерия.
      </p>
      <ul>
        <li>
          <strong>Preview</strong> — прогон новых весов в памяти, без
          записи в БД. Внутри панели появится таблица «было → стало»
          по каждому домену; AI-вердикты и провенанс остаются прежними,
          меняется только числовой <code>final</code> + bucket.
        </li>
        <li>
          <strong>Apply to this run</strong> — записывает override на
          уровень Run, пересчитывает <code>final_assessment_json</code>{" "}
          и <code>final_summary</code> у каждого non-partial домена.
          Бейдж «override active» появляется в шапке свёрнутой панели.
        </li>
        <li>
          <strong>Reset to global</strong> — снимает override и
          возвращает Run к глобальным весам из Настроек.
        </li>
      </ul>
      <p>
        Видна на запусках в любом состоянии (running / paused / done) —
        раньше панель была только на <code>done</code>, теперь её
        можно открыть мид-ран, чтобы заранее посмотреть, как изменится
        картина, когда оставшиеся домены доедут.
      </p>

      <h2>Live-обновление</h2>
      <p>
        Поллинг адаптивный (2 с пока запуск <code>running</code>, 10 с
        на <code>paused</code>, ноль на терминальных состояниях). Каждый
        тик — лёгкий запрос <code>/runs/&#123;id&#125;/progress</code>{" "}
        (только статус-плашки, без AI-вердиктов и языкового слоя; ~35%
        от веса полного <code>/runs/&#123;id&#125;</code>). Когда
        прогресс-эндпоинт замечает переход домена в терминал или
        обновление <code>last_analyzed_at</code>, автоматически дёргается
        полный эндпоинт — чтобы дорогие колонки (Verdict, Language,
        Theme, Category) обновились без задержки. При возврате во
        вкладку (focus / visibilitychange) полный эндпоинт тоже
        срабатывает сам.
      </p>
    </div>
  );
}

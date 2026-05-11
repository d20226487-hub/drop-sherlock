import Link from "next/link";

export const metadata = { title: "Переоценка — Drop Sherlock" };

export default function ReanalyzeDoc() {
  return (
    <div className="docs-content">
      <h1>Переоценка (Reanalyze)</h1>
      <p>
        Переоценка — это повторный вызов ИИ-судей на уже собранных
        Ahrefs-данных. Полезна, когда фактические данные не поменялись, а
        логика оценки — да: вы отредактировали промпт, поменяли модель,
        хотите второе мнение. Ahrefs не запрашивается заново — токены и
        юниты тратятся только на ИИ.
      </p>

      <h2>Три гранулярности</h2>
      <p>
        Drop Sherlock позволяет переоценить разный объём данных за один
        клик:
      </p>
      <ul>
        <li>
          <strong>Один критерий одного домена</strong> — кнопка «Re-judge»
          на боксе вердикта в{" "}
          <Link href="/docs/domain">странице домена</Link>. Самая дешёвая
          и быстрая.
        </li>
        <li>
          <strong>Весь домен</strong> — кнопка «Reanalyze with AI» внизу
          страницы домена. Перепрогоняет все ИИ-судьи + final synth.
        </li>
        <li>
          <strong>Весь запуск</strong> — кнопка «Reanalyze with AI» на{" "}
          <Link href="/docs/run">странице запуска</Link>. Перепрогоняет
          все домены запуска.
        </li>
      </ul>

      <h2>Выбор модели</h2>
      <p>
        Перед запуском переоценки можно сменить провайдера и модель —
        ровно как на форме Анализа. Это позволяет:
      </p>
      <ul>
        <li>
          Сравнить, как один и тот же домен оценили разные модели.
        </li>
        <li>
          Переписать вердикт «дешёвой» модели на «дорогой» только для
          топ-кандидатов, не платя за всю массу.
        </li>
      </ul>
      <p>
        Provider/Model по-умолчанию подставляются из <em>предыдущего</em>{" "}
        вердикта на этом домене (а не из spec.ai задачи). Если вы уже
        переоценивали на Sonnet, повторный «Re-judge» по умолчанию даст
        Sonnet — повторяет ваш предыдущий выбор.
      </p>

      <h2>Что переписывается</h2>
      <ul>
        <li>
          <strong>ai_verdict_json</strong> — текст вердикта.
        </li>
        <li>
          <strong>ai_provider</strong>, <strong>ai_model</strong> — кто
          выдал.
        </li>
        <li>
          <strong>prompt_hash</strong> — хеш промпта, с которым звали.
        </li>
        <li>
          <strong>ai_input_tokens / output_tokens / cost_usd</strong> —
          обновлённый учёт.
        </li>
        <li>
          <strong>ai_cached_from_run_id</strong> — сбрасывается в null
          (вердикт теперь свежий, не из кэша).
        </li>
      </ul>
      <p>
        Сырые Ahrefs-данные (data_json) и cached_from_run_id данных{" "}
        <em>не трогаются</em> — переоценка живёт поверх той же фактической
        базы.
      </p>

      <h2>Влияние на final assessment</h2>
      <p>
        При переоценке одного критерия итоговый final score автоматически
        пересчитывается (он детерминирован — см.{" "}
        <Link href="/docs/brain">«Brain»</Link>), но <em>текст</em>{" "}
        final summary остаётся прежним: его генерировал ИИ на основе
        старого набора sub-verdicts. Если вы хотите свежий нарратив — жмите
        «Reanalyze with AI» на целом домене, тогда и final synth тоже
        перепишется.
      </p>

      <h2>Когда чем пользоваться</h2>
      <table>
        <thead>
          <tr>
            <th>Сценарий</th>
            <th>Гранулярность</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>«ИИ оценил один критерий явно странно — хочу пересмотреть»</td>
            <td>Re-judge одного критерия</td>
          </tr>
          <tr>
            <td>«Хочу применить новый промпт ко всему домену»</td>
            <td>Reanalyze with AI на странице домена</td>
          </tr>
          <tr>
            <td>«Поменял промпт под всю задачу — нужны свежие вердикты»</td>
            <td>Reanalyze with AI на странице запуска</td>
          </tr>
          <tr>
            <td>«Хочу A/B-тест моделей на 200 доменах»</td>
            <td>Rerun (новый Run в той же Job) — см. Workflow</td>
          </tr>
        </tbody>
      </table>

      <div className="callout callout-info docs-content">
        <p>
          <strong>Подсказка:</strong> переоценка не создаёт новый Run — она
          переписывает существующие CriterionResult-строки. Если хотите
          сохранить старый вердикт для сравнения, используйте Rerun (см.{" "}
          <Link href="/docs/jobs">Задачи</Link>) — он создаёт второй Run в
          той же задаче, и оба будут видны в Compare runs.
        </p>
      </div>
    </div>
  );
}

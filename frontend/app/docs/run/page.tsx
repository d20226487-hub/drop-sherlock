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
          Reanalyze / Pin entire run.
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
          <strong>Pin</strong> — закрепить именно этот RunDomain как
          канонический для домена в Базе.
        </li>
      </ul>

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

      <h2>Pin entire run</h2>
      <p>
        Кнопка делает сразу две вещи:
      </p>
      <ol>
        <li>
          Закрепляет каждый домен этого запуска как канонический в{" "}
          <Link href="/docs/database">Базе</Link>.
        </li>
        <li>
          Если запуск <code>done</code>, дополнительно закрепляет его на
          уровне Задачи (как источник плашек сводки).
        </li>
      </ol>
      <p>
        Это «полная фиксация»: «этот запуск — мой эталон по всем
        измерениям». Подробно — в{" "}
        <Link href="/docs/pinning">«Закрепление»</Link>.
      </p>

      <h2>Live-обновление</h2>
      <p>
        Страница подписана на SSE-поток с бекенда — статусы доменов
        обновляются автоматически без перезагрузки. Если SSE по какой-то
        причине недоступен (proxy режет), есть fallback на polling каждые
        пару секунд.
      </p>
    </div>
  );
}

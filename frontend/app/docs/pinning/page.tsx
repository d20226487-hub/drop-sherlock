import Link from "next/link";

export const metadata = { title: "Закрепление — Drop Sherlock" };

export default function PinningDoc() {
  return (
    <div className="docs-content">
      <h1>Закрепление (Pinning)</h1>
      <p>
        В Drop Sherlock <strong>три</strong> разных пина. Они часто
        путаются, особенно потому что одна кнопка («Pin entire run») делает
        сразу два из них. Эта статья — карта того, что какой пин делает.
      </p>

      <h2>Три уровня</h2>
      <table>
        <thead>
          <tr>
            <th>Уровень</th>
            <th>Что закрепляет</th>
            <th>На что влияет</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <strong>RunDomain.is_pinned</strong>
            </td>
            <td>
              Один конкретный RunDomain (домен × запуск)
            </td>
            <td>
              <Link href="/docs/database">Базу</Link>: какой RunDomain
              выводится как канонический для домена
            </td>
          </tr>
          <tr>
            <td>
              <strong>Run.is_pinned</strong>
            </td>
            <td>Один конкретный Run (один на Job)</td>
            <td>
              <Link href="/docs/jobs">Страницу задачи</Link>: какой запуск
              даёт цифры для сводных плашек
            </td>
          </tr>
          <tr>
            <td>
              <strong>«Pin entire run»</strong>
            </td>
            <td>
              Всё разом: и Run.is_pinned, и RunDomain.is_pinned для всех
              доменов этого запуска
            </td>
            <td>И Базу, и страницу задачи одновременно</td>
          </tr>
        </tbody>
      </table>

      <h2>RunDomain pin (per-domain)</h2>
      <p>
        Один домен может анализироваться много раз (разные задачи, reruns,
        переоценки). Без пина Drop Sherlock не знал бы, какой из этих
        RunDomain считать «истиной» в Базе. Закреплённый RunDomain — это
        ваш явный ответ: «вот этот вариант, его и показывай в строке
        Базы».
      </p>
      <p>Инвариант: <em>не больше одного пина на домен</em>.</p>
      <p>Где закрепляется:</p>
      <ul>
        <li>
          В <Link href="/docs/database">Базе</Link>, колонка{" "}
          <strong>Pin</strong> — селектор со списком всех RunDomain того же
          домена.
        </li>
        <li>
          В <Link href="/docs/domain">странице домена</Link>, кнопка{" "}
          <strong>«Pin this RunDomain as canonical»</strong>.
        </li>
        <li>
          В <Link href="/docs/run">странице запуска</Link>, колонка{" "}
          <strong>Pin</strong> в каждой строке.
        </li>
      </ul>

      <h2>Run pin (per-job)</h2>
      <p>
        У одной задачи (Job) может быть несколько Runs. Какой из них
        представляет «состояние» задачи в сводных плашках? Без пина — самый
        свежий (max(Run.id)). С пином — закреплённый.
      </p>
      <p>
        Зачем нужно: вы сделали полный прогон 200 доменов, а затем
        частичный rerun только 10 доменов под A/B-тест промпта. По
        умолчанию плашки покажут статистику по этим 10 доменам (последний
        run) — что вводит в заблуждение. Закрепляете полный 200-доменный
        run — плашки возвращаются к полной картине.
      </p>
      <p>Инварианты:</p>
      <ul>
        <li>Не больше одного пина на задачу.</li>
        <li>Закрепить можно только <code>done</code>-запуск.</li>
        <li>
          Закрепление другого запуска <em>заменяет</em> старый пин (без
          подтверждения — это «переключатель»).
        </li>
      </ul>
      <p>Где закрепляется:</p>
      <ul>
        <li>
          На <Link href="/docs/jobs">странице задачи</Link>, в строке
          каждого Run — кнопка <strong>«Pin»</strong> (для{" "}
          <code>done</code>; иначе кнопка скрыта).
        </li>
      </ul>

      <h2>«Pin entire run» — комбо</h2>
      <p>
        На <Link href="/docs/run">странице запуска</Link> кнопка{" "}
        <strong>«Pin entire run»</strong> делает сразу две вещи:
      </p>
      <ol>
        <li>
          Помечает каждый RunDomain этого запуска как канонический в Базе
          (заменяя пины, которые могли стоять на других RunDomain тех же
          доменов).
        </li>
        <li>
          Если статус запуска <code>done</code>, дополнительно закрепляет
          сам Run на уровне задачи (Run.is_pinned).
        </li>
      </ol>
      <p>
        Это «полная фиксация»: «этот запуск — мой эталон по всем
        измерениям». Подходит, когда вы окончательно довольны прогоном.
      </p>

      <h2>Сводная шпаргалка</h2>
      <table>
        <thead>
          <tr>
            <th>Хочу...</th>
            <th>Какой пин</th>
            <th>Где</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Чтобы конкретный анализ домена был источником в Базе</td>
            <td>RunDomain.is_pinned</td>
            <td>Database → колонка Pin / Domain page → Pin</td>
          </tr>
          <tr>
            <td>Чтобы плашки задачи считались по конкретному прогону</td>
            <td>Run.is_pinned</td>
            <td>Job page → строка запуска → Pin</td>
          </tr>
          <tr>
            <td>Зафиксировать запуск целиком как эталон</td>
            <td>Pin entire run (комбо)</td>
            <td>Run page → Pin entire run</td>
          </tr>
          <tr>
            <td>Откатить — Database вернётся к latest</td>
            <td>Unpin RunDomain</td>
            <td>Database → колонка Pin → Unpin</td>
          </tr>
          <tr>
            <td>Откатить — плашки задачи вернутся к latest</td>
            <td>Unpin Run</td>
            <td>Job page → строка запуска → Unpin</td>
          </tr>
        </tbody>
      </table>

      <div className="callout callout-info docs-content">
        <p>
          <strong>На что обратить внимание:</strong> «Pin entire run»
          делает per-domain пины <em>всем</em> доменам запуска. Если у вас
          были аккуратные ручные пины на конкретных доменах из старых
          задач, они будут переписаны. Чтобы не потерять — используйте
          обычный «Pin» в строке запуска (Job page) для уровня задачи и
          отдельные RunDomain-пины для тонких случаев.
        </p>
      </div>
    </div>
  );
}

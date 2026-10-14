#!/usr/bin/env python3
"""Load a cutover input into the owner's account, reset it, or sign it off (STU-202).

    DATABASE_URL=... python backend/scripts/cutover_load.py --input IN.json \\
        --report REPORT.json --expect-host HOST --expect-db DB --dry-run
    ... --run-record RECORD.json --expect-server-addr ADDR      (the real load)
    ... --reset --run-record RECORD.json --confirm OWNER_EMAIL [--dry-run] [--report R.json]
    ... --complete-record --run-record RECORD.json        (after exit code 3)
    python backend/scripts/cutover_load.py --sign-off --run-record RECORD.json \\
        --check-report CHECK.json --confirm OWNER_EMAIL

Thin wrapper over ``app.cutover_load`` (see ``docs/cutover-load.md``). Before
anything from the app is imported it resolves every path argument against
the current directory, moves into an empty temporary directory (so no
``.env`` can load) and validates ``DATABASE_URL`` from the environment. The
terminal shows only check names, counts, pass or fail and the target; the
details go to the 0600 report file. Exit code 0 on success, 1 on any refusal
or error (nothing changed), 3 when the load committed (or its commit's outcome
is unknown) but its run record could not be marked complete (run
``--complete-record``, whose fingerprint check decides).
"""

import argparse
import os
import sys
import tempfile

BACKEND = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
PATH_ARGS = ("input", "report", "run_record", "check_report")


def parse_args(argv):
    p = argparse.ArgumentParser(prog="cutover_load.py", description=__doc__.split("\n\n")[0])
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--reset", action="store_true", help="undo the load inside the window")
    mode.add_argument("--sign-off", action="store_true", help="close the window after C3 passes")
    mode.add_argument("--complete-record", action="store_true",
                      help="mark a prepared run record complete after exit code 3")
    p.add_argument("--dry-run", action="store_true", help="validate and write, then roll back")
    p.add_argument("--input", help="the cutover-input v1 JSON file")
    p.add_argument("--report", help="where to write the review or failure report (new file)")
    p.add_argument("--run-record", help="the run record (written by a load; read otherwise)")
    p.add_argument("--check-report", help="the cutover check's report (sign-off)")
    p.add_argument("--confirm", help="the owner's email (reset, sign-off)")
    p.add_argument("--expect-host", help="the host DATABASE_URL must name")
    p.add_argument("--expect-db", help="the database DATABASE_URL must name")
    p.add_argument("--expect-server-addr", help="the server address the database must report")
    return p, p.parse_args(argv)


def required(p, args, *names):
    missing = [n for n in names if not getattr(args, n.lstrip("-").replace("-", "_"))]
    if missing:
        p.error(f"this mode needs {', '.join(missing)}")


def main(argv=None) -> int:
    p, args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.sign_off:
        required(p, args, "--run-record", "--check-report", "--confirm")
    elif args.complete_record:
        required(p, args, "--run-record", "--expect-host", "--expect-db", "--expect-server-addr")
    elif args.reset:
        required(p, args, "--run-record", "--confirm", "--expect-host", "--expect-db",
                 "--expect-server-addr")
    else:
        required(p, args, "--input", "--report", "--expect-host", "--expect-db")
        if not args.dry_run:
            required(p, args, "--run-record", "--expect-server-addr")
    try:
        # Absolute paths first, against the directory the owner ran this from.
        for name in PATH_ARGS:
            if getattr(args, name):
                setattr(args, name, os.path.realpath(getattr(args, name)))
        # Hermetic import: an empty working directory, so no .env can load.
        os.chdir(tempfile.mkdtemp(prefix="cutover-load-"))
    except Exception as exc:  # a filesystem error's message would carry a path
        print(f"error: {type(exc).__name__}")
        return 1
    sys.path.insert(0, BACKEND)
    try:
        from app.cutover_load import bootstrap, outputs
    except Exception as exc:  # never a traceback: it could print environment values
        print(f"error: {type(exc).__name__}")
        return 1

    report_path = None
    try:
        for name in PATH_ARGS:
            if getattr(args, name):
                outputs.outside_repo(getattr(args, name), name.replace("_", " "))
        report_path = args.report
        if args.sign_off:
            from app.cutover_load.reset import sign_off

            return sign_off(run_record_path=args.run_record, check_report_path=args.check_report,
                            confirm=args.confirm)
        raw = bootstrap.read_url()
        bootstrap.check_pg_environment()
        url = bootstrap.validate_url(raw, expect_host=args.expect_host, expect_db=args.expect_db)
        print(bootstrap.target_line(url))
        if args.complete_record:
            from app.cutover_load.loader import complete_record

            return complete_record(url=url, run_record_path=args.run_record,
                                   expect_db=args.expect_db,
                                   expect_server_addr=args.expect_server_addr)
        if args.reset:
            from app.cutover_load.reset import run_reset

            return run_reset(url=url, run_record_path=args.run_record, confirm=args.confirm,
                             dry_run=args.dry_run, expect_db=args.expect_db,
                             expect_server_addr=args.expect_server_addr,
                             report_path=args.report)
        from app.cutover_load.loader import run_load

        return run_load(url=url, input_path=args.input, report_path=args.report,
                        run_record_path=args.run_record, dry_run=args.dry_run,
                        expect_db=args.expect_db, expect_server_addr=args.expect_server_addr)
    except Exception as exc:  # every refusal and error: check names only on the terminal
        # Includes an import of the app that fails settings validation: only the
        # error class is printed, never a traceback holding environment values.
        return refuse(exc, report_path)


def refuse(exc: Exception, report_path) -> int:
    from app.cutover_load.bootstrap import Refused, error_class

    if getattr(exc, "check", None) == "commit_unknown":
        print("load: commit outcome UNKNOWN; the run record is prepared")
        print("decide with --complete-record --run-record PATH and the same target flags")
        return 3
    if getattr(exc, "check", None) == "committed_incomplete":
        print("load: COMMITTED; run record incomplete")
        print("recover with --complete-record --run-record PATH and the same target flags")
        return 3
    problems = getattr(exc, "problems", None)
    if problems is not None:
        for problem in problems:
            print(f"FAIL {problem.check} [{problem.key}]")
    elif isinstance(exc, Refused):
        print(f"refused: {exc.check}: {exc.message}")
    elif hasattr(exc, "check") and hasattr(exc, "key"):
        print(f"FAIL {exc.check} [{exc.key}]")
    else:
        print(f"error: {error_class(exc)}")
    if report_path and "app.cutover_load.loader" in sys.modules:
        from app.cutover_load.loader import failure_report
        from app.cutover_load.outputs import create_private, to_json

        try:
            create_private(report_path, to_json(failure_report(exc)))
            print("details: written to the report file")
        except Exception:
            pass
    return 1


if __name__ == "__main__":
    sys.exit(main())

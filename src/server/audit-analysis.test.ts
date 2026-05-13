import { describe, it, expect } from "vitest";
import { DECORATOR_ENTRY_POINT } from "./audit-analysis.js";

// Regression suite for DECORATOR_ENTRY_POINT — the regex that exempts
// framework-decorated symbols from orphan detection. Three real bugs
// shipped in May 2026 because this regex didn't cover patterns the bench
// surfaced (TS/NestJS shipped in v0.20.9, Python in v0.20.19). Without
// these tests, each new framework can only be caught empirically.
describe("DECORATOR_ENTRY_POINT — framework decorators (v0.20.19)", () => {
  describe("Python attribute-access routing (FastAPI/Flask/Starlette)", () => {
    const cases: [string, boolean][] = [
      ["@app.get('/users')", true],
      ["@app.post('/items')", true],
      ["@app.put('/orders/{id}')", true],
      ["@app.delete('/items/{id}')", true],
      ["@app.patch('/users/{id}')", true],
      ["@app.exception_handler(404)", true],
      ["@app.websocket('/ws')", true],
      ["@app.include_router(router)", true],
      ["@router.get('/items')", true],
      ["@router.post('/items')", true],
      ["@bp.route('/admin')", true],
      ["@blueprint.before_request", true],
      ["  @app.get('/users')", true], // indented (method decorator)
      ["app.get('/users')", false], // not a decorator (no @)
      ["foo.app.get('/x')", false], // not at start of line
    ];
    it.each(cases)("matches %s = %s", (src, expected) => {
      DECORATOR_ENTRY_POINT.lastIndex = 0;
      expect(DECORATOR_ENTRY_POINT.test(src)).toBe(expected);
    });
  });

  describe("Python validator + framework decorators (Pydantic/pytest/Click)", () => {
    const cases: [string, boolean][] = [
      ["@validator('name')", true],
      ["@field_validator('email')", true],
      ["@root_validator", true],
      ["@model_validator(mode='after')", true],
      ["@computed_field", true],
      ["@pytest.fixture", true],
      ["@pytest.fixture(scope='module')", true],
      ["@click.command", true],
      ["@click.option('--verbose')", true],
      ["@click.argument('name')", true],
      ["@hookimpl", true],
      ["@hookspec", true],
      ["@cached_property", true],
      ["@asynccontextmanager", true],
      ["validator('name')", false], // not a decorator
    ];
    it.each(cases)("matches %s = %s", (src, expected) => {
      DECORATOR_ENTRY_POINT.lastIndex = 0;
      expect(DECORATOR_ENTRY_POINT.test(src)).toBe(expected);
    });
  });

  describe("TS/JS PascalCase framework decorators (NestJS/TypeORM)", () => {
    const cases: [string, boolean][] = [
      ["@Get('/users')", true],
      ["@Post('/items')", true],
      ["@Injectable()", true],
      ["@Controller('users')", true],
      ["@Module({})", true],
      ["@Entity()", true],
      ["@Column()", true],
      ["@PrimaryColumn()", true],
      ["@OneToMany(() => Foo)", true],
      ["@Mutation(() => User)", true],
      ["@OnEvent('user.created')", true],
      ["Get('/users')", false], // not a decorator
    ];
    it.each(cases)("matches %s = %s", (src, expected) => {
      DECORATOR_ENTRY_POINT.lastIndex = 0;
      expect(DECORATOR_ENTRY_POINT.test(src)).toBe(expected);
    });
  });
});

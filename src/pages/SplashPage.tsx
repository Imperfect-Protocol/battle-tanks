import { Link } from "react-router-dom";

export function SplashPage() {
  return (
    <main className="screen splash-screen">
      <div className="splash-mark">
        <p>Imperfect Protocol</p>
        <h1>BATTLE TANKS</h1>
      </div>
      <Link className="button button--primary splash-enter" to="/sign-in">
        Enter
      </Link>
    </main>
  );
}

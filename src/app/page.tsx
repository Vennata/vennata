import { signInWithGoogle } from "./auth/actions";

// Placeholder landing page. We'll design the real one once posters exist.
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="space-y-3">
        <h1 className="text-5xl font-bold tracking-tight">Vennata</h1>
        <p className="text-lg text-neutral-500">
          Every tool. One poster. All year. With your whole team.
        </p>
      </div>

      <form action={signInWithGoogle}>
        <button
          type="submit"
          className="rounded-full bg-foreground px-6 py-3 font-medium text-background transition hover:opacity-80"
        >
          Sign in with Google
        </button>
      </form>
    </main>
  );
}

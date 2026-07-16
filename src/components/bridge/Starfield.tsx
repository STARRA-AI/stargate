"use client";

export function Starfield() {
  return (
    <>
      <div
        className="starfield-a pointer-events-none absolute inset-0 z-0 opacity-25"
        aria-hidden
        style={{
          backgroundImage: `
            radial-gradient(1px 1px at 12% 18%, #e9d5ff 100%, transparent),
            radial-gradient(1px 1px at 78% 12%, #c4b5fd 100%, transparent),
            radial-gradient(1px 1px at 34% 72%, #a855f7 100%, transparent),
            radial-gradient(1px 1px at 88% 58%, #e9d5ff 100%, transparent),
            radial-gradient(1px 1px at 52% 40%, #d946ef 100%, transparent)
          `,
          backgroundSize: "640px 640px",
        }}
      />
      <div
        className="starfield-b pointer-events-none absolute inset-0 z-0 opacity-15"
        aria-hidden
        style={{
          backgroundImage: `
            radial-gradient(1.5px 1.5px at 22% 44%, #c4b5fd 100%, transparent),
            radial-gradient(1px 1px at 66% 28%, #e9d5ff 100%, transparent),
            radial-gradient(1px 1px at 40% 86%, #a855f7 100%, transparent)
          `,
          backgroundSize: "900px 900px",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 z-0 opacity-40"
        aria-hidden
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(168,85,247,0.03) 0px, rgba(168,85,247,0.03) 1px, transparent 1px, transparent 3px)",
        }}
      />
    </>
  );
}

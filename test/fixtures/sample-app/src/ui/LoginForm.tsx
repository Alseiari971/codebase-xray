export function Button(props: { label: string }) {
  return <button>{props.label}</button>;
}

export default function LoginForm() {
  return (
    <form>
      <Button label="Sign in" />
    </form>
  );
}

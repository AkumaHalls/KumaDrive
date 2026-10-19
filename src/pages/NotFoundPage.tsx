import { FileQuestion } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] p-8 text-center">
      <FileQuestion className="h-16 w-16 text-muted-foreground mb-4" />
      <h2 className="text-2xl font-bold tracking-tight mb-2">404 - Página não encontrada</h2>
      <p className="text-muted-foreground mb-6">A página que você está procurando não existe.</p>
      <Link to="/drive/my-drive">
        <Button>Ir para Meu Drive</Button>
      </Link>
    </div>
  );
}

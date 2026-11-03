-- CreateTable
CREATE TABLE "Paciente" (
    "id" UUID NOT NULL,
    "cpf" VARCHAR(11) NOT NULL,
    "nome" VARCHAR(150) NOT NULL,
    "dataNascimento" DATE NOT NULL,
    "telefone" VARCHAR(15) NOT NULL,
    "criadoEm" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Paciente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lembrete" (
    "id" UUID NOT NULL,
    "pacienteId" UUID NOT NULL,
    "dataConsulta" DATE NOT NULL,
    "programadoPara" TIMESTAMPTZ(6) NOT NULL,
    "limiteEnvio" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "proximaTentativa" TIMESTAMPTZ(6),
    "reservadoAte" TIMESTAMPTZ(6),
    "envioId" UUID,
    "erro" VARCHAR(255),
    "criadoEm" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Lembrete_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ControleConversa" (
    "id" UUID NOT NULL,
    "instancia" VARCHAR(100) NOT NULL,
    "telefone" VARCHAR(15) NOT NULL,
    "pausadoAte" TIMESTAMPTZ(6),
    "ultimaIntervencaoManual" TIMESTAMPTZ(6),
    "ultimaRetomadaExplicita" TIMESTAMPTZ(6),

    CONSTRAINT "ControleConversa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventoProcessado" (
    "id" UUID NOT NULL,
    "instancia" VARCHAR(100) NOT NULL,
    "mensagemId" VARCHAR(150) NOT NULL,
    "direcao" VARCHAR(10) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PROCESSANDO',
    "recebidoEm" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluidoEm" TIMESTAMPTZ(6),

    CONSTRAINT "EventoProcessado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvioBot" (
    "id" UUID NOT NULL,
    "instancia" VARCHAR(100) NOT NULL,
    "telefone" VARCHAR(15) NOT NULL,
    "finalidade" VARCHAR(40) NOT NULL,
    "referenciaId" UUID,
    "conteudo" TEXT,
    "mensagemId" VARCHAR(150),
    "status" VARCHAR(20) NOT NULL DEFAULT 'PREPARADO',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "iniciadoEm" TIMESTAMPTZ(6),
    "concluidoEm" TIMESTAMPTZ(6),
    "criadoEm" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvioBot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Paciente_cpf_key" ON "Paciente"("cpf");

-- CreateIndex
CREATE UNIQUE INDEX "Paciente_telefone_key" ON "Paciente"("telefone");

-- CreateIndex
CREATE INDEX "Lembrete_status_proximaTentativa_programadoPara_idx" ON "Lembrete"("status", "proximaTentativa", "programadoPara");

-- CreateIndex
CREATE UNIQUE INDEX "Lembrete_pacienteId_dataConsulta_key" ON "Lembrete"("pacienteId", "dataConsulta");

-- CreateIndex
CREATE UNIQUE INDEX "ControleConversa_instancia_telefone_key" ON "ControleConversa"("instancia", "telefone");

-- CreateIndex
CREATE UNIQUE INDEX "EventoProcessado_instancia_mensagemId_direcao_key" ON "EventoProcessado"("instancia", "mensagemId", "direcao");

-- CreateIndex
CREATE INDEX "EnvioBot_instancia_telefone_status_criadoEm_idx" ON "EnvioBot"("instancia", "telefone", "status", "criadoEm");

-- CreateIndex
CREATE UNIQUE INDEX "EnvioBot_instancia_mensagemId_key" ON "EnvioBot"("instancia", "mensagemId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvioBot_finalidade_referenciaId_key" ON "EnvioBot"("finalidade", "referenciaId");

-- AddForeignKey
ALTER TABLE "Lembrete" ADD CONSTRAINT "Lembrete_pacienteId_fkey" FOREIGN KEY ("pacienteId") REFERENCES "Paciente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


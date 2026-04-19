import OpenAI from "openai"
import { createClient } from "@supabase/supabase-js"

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
)

const ADMIN_TOKEN = process.env.ADMIN_TOKEN

export default async function handler(req, res){

try{

/* ================= SEGURANÇA ================= */

if(req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`){
  return res.status(403).json({ erro:"acesso negado" })
}

/* ================= BODY ================= */

const body =
typeof req.body === "string"
? JSON.parse(req.body)
: req.body

const pergunta = body?.pergunta || ""
const projetoNome = body?.projeto || ""

/* ================= BUSCAR PROJETO ================= */

let projeto = null

if(projetoNome){

  const { data } = await supabase
    .from("projetos_n2")
    .select("*")
    .ilike("nome", `%${projetoNome}%`)
    .limit(1)

  projeto = data?.[0]
}

/* ================= BUSCAR ARQUIVOS ================= */

let arquivos = []

if(projeto){

  const { data } = await supabase
    .from("arquivos_projeto")
    .select("*")
    .eq("projeto_id", projeto.id)
    .order("atualizado_em", { ascending:false })

  arquivos = data || []
}

/* ================= FILTRO INTELIGENTE ================= */

const texto = pergunta.toLowerCase()

let arquivosSelecionados = arquivos

// 🔥 tenta reduzir contexto automaticamente
if(arquivos.length > 20){

  arquivosSelecionados = arquivos.filter(a =>
    texto.includes(a.nome_arquivo?.toLowerCase()) ||
    texto.includes(a.caminho?.toLowerCase())
  )

  if(arquivosSelecionados.length === 0){
    arquivosSelecionados = arquivos.slice(0, 20)
  }
}

/* ================= LIMITAR TAMANHO ================= */

const LIMITE_CODIGO = 12000 // caracteres por arquivo

const arquivosContexto = arquivosSelecionados.map(a => ({
  id: a.id,
  nome: a.nome_arquivo,
  caminho: a.caminho,
  linguagem: a.linguagem,
  codigo: (a.codigo || "").slice(0, LIMITE_CODIGO)
}))

/* ================= PROMPT INTERNO ================= */

const PROMPT_DEV = `
💻 AGENTE PROGRAMADOR N2

Você é um engenheiro de software nível sênior.

Você tem acesso a arquivos reais de código.

🎯 SUA FUNÇÃO:

- Corrigir bugs
- Refatorar código
- Melhorar performance
- Criar novas funções
- Ajustar APIs
- Melhorar segurança

📂 CONTEXTO:

Você receberá arquivos com:
- id
- nome
- caminho
- linguagem
- codigo

⚠️ REGRAS CRÍTICAS:

- Nunca inventar código fora do contexto
- Sempre manter estrutura original
- Nunca remover funcionalidades sem motivo
- Sempre retornar código COMPLETO (arquivo inteiro)
- Nunca retornar trecho parcial

⚠️ FORMATO OBRIGATÓRIO:

Se for alteração:

ALTERAR_CODIGO_JSON:
{
  "arquivo_id": "",
  "codigo_novo": "",
  "descricao": ""
}

Se for criação:

CRIAR_ARQUIVO_JSON:
{
  "nome": "",
  "caminho": "",
  "linguagem": "",
  "codigo": ""
}

Se for análise:

ANALISE_TECNICA:
"texto aqui"

⚠️ Nunca responder fora desses formatos quando aplicável
`

/* ================= OPENAI ================= */

const completion = await openai.chat.completions.create({

  model: "gpt-4.1",
  temperature: 0,

  messages: [

    {
      role: "system",
      content: PROMPT_DEV
    },

    {
      role: "system",
      content: `PROJETO:\n${JSON.stringify(projeto || {})}`
    },

    {
      role: "system",
      content: `ARQUIVOS:\n${JSON.stringify(arquivosContexto)}`
    },

    {
      role: "user",
      content: pergunta
    }

  ]

})

let resposta = completion.choices[0].message.content

/* ================= DETECTAR ALTERAÇÃO ================= */

const matchAlterar = resposta.match(/ALTERAR_CODIGO_JSON:\s*(\{[\s\S]*\})/)

if(matchAlterar){

  try{

    const json = JSON.parse(
      matchAlterar[1]
      .replace(/```json/g,"")
      .replace(/```/g,"")
      .trim()
    )

    await supabase
      .from("arquivos_projeto")
      .update({
        codigo: json.codigo_novo,
        atualizado_em: new Date()
      })
      .eq("id", json.arquivo_id)

    return res.json({
      tipo:"alteracao",
      descricao: json.descricao
    })

  }catch(e){
    console.error("Erro alteração:", e)
  }
}

/* ================= DETECTAR CRIAÇÃO ================= */

const matchCriar = resposta.match(/CRIAR_ARQUIVO_JSON:\s*(\{[\s\S]*\})/)

if(matchCriar){

  try{

    const json = JSON.parse(
      matchCriar[1]
      .replace(/```json/g,"")
      .replace(/```/g,"")
      .trim()
    )

    await supabase
      .from("arquivos_projeto")
      .insert({
        projeto_id: projeto.id,
        nome_arquivo: json.nome,
        caminho: json.caminho,
        linguagem: json.linguagem,
        codigo: json.codigo
      })

    return res.json({
      tipo:"criacao",
      arquivo: json.nome
    })

  }catch(e){
    console.error("Erro criação:", e)
  }
}

/* ================= RESPOSTA NORMAL ================= */

return res.json({
  tipo:"resposta",
  resposta
})

}catch(e){

console.error("ERRO GERAL:", e)

return res.status(500).json({
  erro:"erro interno"
})

}
}

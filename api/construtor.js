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

const body = typeof req.body === "string"
? JSON.parse(req.body)
: req.body

const pergunta = body?.pergunta || ""
const projetoNome = body?.projeto || "default"

/* ================= BUSCAR PROJETO ================= */

let projeto = null

const { data:proj } = await supabase
  .from("projetos_n2")
  .select("*")
  .ilike("nome", `%${projetoNome}%`)
  .limit(1)

projeto = proj?.[0]

/* ================= BUSCAR ARQUIVOS ================= */

let arquivos = []

if(projeto){
  const { data } = await supabase
    .from("arquivos_projeto")
    .select("*")
    .eq("projeto_id", projeto.id)
    .order("atualizado_em",{ascending:false})

  arquivos = data || []
}

/* ================= CONTEXTO INTELIGENTE ================= */

const LIMITE = 12000

const arquivosContexto = arquivos.slice(0,15).map(a => ({
  id: a.id,
  nome: a.nome_arquivo,
  caminho: a.caminho,
  linguagem: a.linguagem,
  codigo: (a.codigo || "").slice(0, LIMITE)
}))

/* ================= PROMPT ================= */

const PROMPT = `
Você é um engenheiro de software sênior.

Regras:
- Sempre pensar como desenvolvedor real
- Nunca retornar código parcial
- Sempre retornar arquivo completo
- Nunca quebrar funcionalidades existentes

Se modificar código:

ALTERAR_CODIGO_JSON:
{
 "arquivo_id":"",
 "codigo_novo":"",
 "descricao":""
}

Se criar:

CRIAR_ARQUIVO_JSON:
{
 "nome":"",
 "caminho":"",
 "linguagem":"",
 "codigo":""
}

Se só conversar:
responda normalmente
`

/* ================= GPT ================= */

const completion = await openai.chat.completions.create({
  model:"gpt-4.1",
  temperature:0,
  messages:[
    {role:"system",content:PROMPT},
    {role:"system",content:`PROJETO:\n${JSON.stringify(projeto || {})}`},
    {role:"system",content:`ARQUIVOS:\n${JSON.stringify(arquivosContexto)}`},
    {role:"user",content:pergunta}
  ]
})

let resposta = completion.choices[0].message.content

/* ================= SALVAR CONVERSA ================= */

await supabase.from("dev_conversas").insert({
  projeto: projetoNome,
  role:"user",
  mensagem: pergunta
})

/* ================= ALTERAÇÃO ================= */

const matchAlterar = resposta.match(/ALTERAR_CODIGO_JSON:\s*(\{[\s\S]*\})/)

if(matchAlterar){

  const json = JSON.parse(matchAlterar[1].replace(/```/g,""))

  const { data:old } = await supabase
    .from("arquivos_projeto")
    .select("*")
    .eq("id", json.arquivo_id)
    .single()

  /* versionamento */
  await supabase.from("dev_versions").insert({
    arquivo_id: json.arquivo_id,
    codigo_antigo: old?.codigo || "",
    codigo_novo: json.codigo_novo,
    descricao: json.descricao
  })

  /* update */
  await supabase
    .from("arquivos_projeto")
    .update({
      codigo: json.codigo_novo,
      atualizado_em: new Date()
    })
    .eq("id", json.arquivo_id)

  await supabase.from("dev_conversas").insert({
    projeto: projetoNome,
    role:"assistant",
    mensagem: json.descricao
  })

  return res.json({
    resposta: "🛠️ " + json.descricao,
    preview: json.codigo_novo
  })
}

/* ================= CRIAÇÃO ================= */

const matchCriar = resposta.match(/CRIAR_ARQUIVO_JSON:\s*(\{[\s\S]*\})/)

if(matchCriar){

  const json = JSON.parse(matchCriar[1].replace(/```/g,""))

  await supabase.from("arquivos_projeto").insert({
    projeto_id: projeto.id,
    nome_arquivo: json.nome,
    caminho: json.caminho,
    linguagem: json.linguagem,
    codigo: json.codigo
  })

  await supabase.from("dev_conversas").insert({
    projeto: projetoNome,
    role:"assistant",
    mensagem: "Arquivo criado: " + json.nome
  })

  return res.json({
    resposta: "📦 Arquivo criado: " + json.nome,
    preview: json.codigo
  })
}

/* ================= RESPOSTA NORMAL ================= */

let preview = null

if(projeto){

  const { data:ultimo } = await supabase
    .from("arquivos_projeto")
    .select("*")
    .eq("projeto_id", projeto.id)
    .order("atualizado_em",{ascending:false})
    .limit(1)

  if(ultimo && ultimo[0]){
    preview = ultimo[0].codigo
  }
}

await supabase.from("dev_conversas").insert({
  projeto: projetoNome,
  role:"assistant",
  mensagem: resposta
})

return res.json({
  resposta,
  preview
})

}catch(e){

console.error(e)

return res.status(500).json({
  erro:"erro interno"
})

}

}

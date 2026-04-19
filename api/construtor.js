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

export default async function handler(req,res){

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

if(!projeto){

  const { data:novo } = await supabase
    .from("projetos_n2")
    .insert({ nome: projetoNome })
    .select()

  projeto = novo[0]

}
/* ================= BUSCAR ARQUIVOS ================= */

const { data:arquivosDB } = await supabase
  .from("arquivos_projeto")
  .select("*")
  .eq("projeto_id", projeto.id)
  .order("atualizado_em",{ascending:false})

const arquivos = arquivosDB || []

/* ================= SELEÇÃO INTELIGENTE ================= */

const texto = pergunta.toLowerCase()

let relevantes = arquivos.filter(a =>
  texto.includes(a.nome_arquivo?.toLowerCase()) ||
  texto.includes(a.caminho?.toLowerCase())
)

if(relevantes.length === 0){
  relevantes = arquivos.slice(0, 10)
}

/* ================= CONTEXTO ================= */

const LIMITE = 12000

const contextoArquivos = relevantes.map(a => ({
  id:a.id,
  nome:a.nome_arquivo,
  caminho:a.caminho,
  linguagem:a.linguagem,
  codigo:(a.codigo || "").slice(0,LIMITE)
}))

/* ================= PROMPT SUPERIOR ================= */

const PROMPT = `
Você é um engenheiro de software sênior nível empresa.

REGRAS:

- Detectar automaticamente problemas no código
- Corrigir SEMPRE que encontrar erro
- Melhorar performance sempre que possível
- Nunca retornar código incompleto
- Sempre retornar arquivo inteiro
- Nunca quebrar funcionalidades existentes

SE houver melhoria:

ALTERAR_CODIGO_JSON:
{
 "arquivo_id":"",
 "codigo_novo":"",
 "descricao":""
}

SE criar:

CRIAR_ARQUIVO_JSON:
{
 "nome":"",
 "caminho":"",
 "linguagem":"",
 "codigo":""
}

SE apenas análise:
explique de forma clara

PRIORIDADE:
1. corrigir erro
2. melhorar código
3. explicar
`

/* ================= OPENAI ================= */

const completion = await openai.chat.completions.create({
  model:"gpt-4.1",
  temperature:0,
  messages:[
    {role:"system",content:PROMPT},
    {role:"system",content:`PROJETO:\n${JSON.stringify(projeto)}`},
    {role:"system",content:`ARQUIVOS:\n${JSON.stringify(contextoArquivos)}`},
    {role:"user",content:pergunta}
  ]
})

let resposta = completion.choices[0].message.content || ""

/* ================= SALVAR PERGUNTA ================= */

await supabase.from("dev_conversas").insert({
  projeto: projetoNome,
  role:"user",
  mensagem: pergunta
})

/* ================= FUNÇÃO PREVIEW ================= */

async function getPreview(){

  const { data } = await supabase
    .from("arquivos_projeto")
    .select("*")
    .eq("projeto_id", projeto.id)
    .order("atualizado_em",{ascending:false})
    .limit(1)

  return data?.[0]?.codigo || "<h1>Sem preview</h1>"
}

/* ================= ALTERAÇÃO ================= */

try{

const matchAlterar = resposta.match(/ALTERAR_CODIGO_JSON:\s*(\{[\s\S]*\})/)

if(matchAlterar){

  const json = JSON.parse(matchAlterar[1].replace(/```/g,""))

  const { data:old } = await supabase
    .from("arquivos_projeto")
    .select("*")
    .eq("id", json.arquivo_id)
    .single()

  await supabase.from("dev_versions").insert({
    arquivo_id: json.arquivo_id,
    codigo_antigo: old?.codigo || "",
    codigo_novo: json.codigo_novo,
    descricao: json.descricao
  })

  await supabase
    .from("arquivos_projeto")
    .update({
      codigo: json.codigo_novo,
      atualizado_em:new Date()
    })
    .eq("id", json.arquivo_id)

  await supabase.from("dev_conversas").insert({
    projeto: projetoNome,
    role:"assistant",
    mensagem: json.descricao
  })

  return res.json({
    resposta:"🛠️ " + json.descricao,
    preview: json.codigo_novo
  })

}

}catch(e){
  console.log("Erro parse alteração:",e)
}

/* ================= CRIAÇÃO ================= */

try{

const matchCriar = resposta.match(/CRIAR_ARQUIVO_JSON:\s*(\{[\s\S]*\})/)

if(matchCriar){

  const json = JSON.parse(matchCriar[1].replace(/```/g,""))

  const { data:novo } = await supabase
    .from("arquivos_projeto")
    .insert({
      projeto_id: projeto.id,
      nome_arquivo: json.nome,
      caminho: json.caminho,
      linguagem: json.linguagem,
      codigo: json.codigo
    })
    .select()

  await supabase.from("dev_conversas").insert({
    projeto: projetoNome,
    role:"assistant",
    mensagem:"Arquivo criado: " + json.nome
  })

  return res.json({
    resposta:"📦 Arquivo criado: " + json.nome,
    preview: json.codigo
  })

}

}catch(e){
  console.log("Erro criação:",e)
}

/* ================= RESPOSTA NORMAL ================= */

await supabase.from("dev_conversas").insert({
  projeto: projetoNome,
  role:"assistant",
  mensagem: resposta
})

const preview = await getPreview()

return res.json({
  resposta,
  preview
})

}catch(e){

console.error("ERRO GERAL:",e)

return res.status(500).json({
  erro:"erro interno"
})

}

}

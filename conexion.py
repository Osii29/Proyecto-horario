import requests
import html

# tipo = 2: busqueda de horarios
#sem 33: semestre 26-1
# carr 12: carrera(Ingenieria en Computacion)
payload = {'tipo': 2, 'sem': 33, 'carr':12, 'grupo':1559}
r = requests.get('https://www.aragon.unam.mx/horarios/horarios/index_archivos/php/queysA.php', params=payload)

#lo cambia a un diccionario de python json
r.encoding = 'utf-8'
horario = r.json()


#corrige los caracteres especiales
def FormatoHorario(horario):
    resultado = []
    for item in horario:
        resultado.append({
            'Materia': html.unescape(item['nomb_cmateria']).encode('cp1252').decode('utf-8'),
            'Profesor': html.unescape(item['nomb_prof']).encode('cp1252').decode('utf-8'),
            'Salon': html.unescape(item['clv_salon']),
            'Lunes' : html.unescape(item['LU']).split("<br />") if item['LU'] else [],
            'Martes': html.unescape(item['MA']).split("<br />") if item['MA'] else [],
            'Miercoles' : html.unescape(item['MI']).split("<br />") if item['MI'] else [],
            'Jueves': html.unescape(item['JU']).split("<br />") if item['JU'] else [],
            'Viernes' : html.unescape(item['VI']).split("<br />") if item['VI'] else [],
            'Sabado': html.unescape(item['SA']).split("<br />") if item['SA'] else [],
        })
    return resultado

def BusquedaMateria(horario, materia, criterio):
    materia.strip().lower()
    horarioFormateado = FormatoHorario(horario)
    
    match criterio:
            case "Maestro":
                criterio = materias["Profesor"]
            case "Materia":
                criterio = materias["Materia"]
            case "dia":
                dia = input("Ingrese el dia a buscar: ")
                match dia:
                    case "Lunes":
                        dia = materias["Lunes"]
                    case "Martes":
                        dia = materias["Martes"]
                    case "Miercoles":
                        dia = materias["Miercoles"]
                    case "Jueves":
                        dia = materias["Jueves"]
                    case "Viernes":
                        dia = materias["Viernes"]
                    case "Sabado":
                        dia = materias["sabado"]
                criterio=dia

    for materias in horarioFormateado:
        if materia in criterio.lower():
            print("--- Materia Encontrada ---")
            print(f"Materia: {materias['Materia']}")
            print(f"Profesor: {materias['Profesor']}")
            print(f"Salón: {materias['Salon']}")
            print(f"Lunes: {materias['Lunes']}")
            print(f"Martes: {materias['Martes']}")
            print(f"Miércoles: {materias['Miercoles']}")
            print(f"Jueves: {materias['Jueves']}")
            print(f"Viernes: {materias['Viernes']}")
            print(f"Sábado: {materias['Sabado']}")
            print("-" * 30)
            break